import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import JSZip from "jszip";

import type { ImageJobStore } from "./image-job-store.js";
import type { AppLogger } from "./logger.js";
import {
  filenameForJobItem,
  isValidPublicJobId,
  toPublicImageJobView,
  type PublicJobItem,
  type PublicImageJobView,
} from "./public-image-job.js";

const LOOKUP_LIMIT = 60;
const LOOKUP_WINDOW_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

type RateBucket = { count: number; resetAt: number };

export function createPublicImageJobRouter(params: {
  imageJobs: ImageJobStore;
  logger: AppLogger;
  fetchImpl?: typeof fetch;
}): Router {
  const router = createRouter();
  const fetchImpl = params.fetchImpl ?? fetch;
  const buckets = new Map<string, RateBucket>();

  router.get("/api/public/image-jobs/:jobId", async (req, res) => {
    if (!allow(req, buckets)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const jobId = String(req.params.jobId ?? "").trim();
    if (!isValidPublicJobId(jobId)) {
      res.status(400).json({ error: "invalid_job_id" });
      return;
    }
    try {
      const record = await params.imageJobs.getByJobId(jobId);
      if (!record) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(200).json(toPublicImageJobView(record));
    } catch (error) {
      params.logger.error({ err: error, jobId }, "public image job lookup failed");
      res.status(500).json({ error: "internal_server_error" });
    }
  });

  router.get("/api/public/image-jobs/:jobId/assets/:index", async (req, res) => {
    if (!allow(req, buckets)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const jobId = String(req.params.jobId ?? "").trim();
    const index = Number(req.params.index);
    if (!isValidPublicJobId(jobId) || !Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const view = await loadPublicView(params.imageJobs, jobId);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const item = view.items[index];
      if (!item?.asset?.url) {
        res.status(404).json({ error: "asset_not_found" });
        return;
      }
      await pipeAssetDownload(fetchImpl, item, filenameForJobItem(jobId, item), res, params.logger);
    } catch (error) {
      params.logger.error({ err: error, jobId, index }, "public asset download failed");
      if (!res.headersSent) res.status(502).json({ error: "upstream_fetch_failed" });
    }
  });

  router.get("/api/public/image-jobs/:jobId/download.zip", async (req, res) => {
    if (!allow(req, buckets)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const jobId = String(req.params.jobId ?? "").trim();
    if (!isValidPublicJobId(jobId)) {
      res.status(400).json({ error: "invalid_job_id" });
      return;
    }
    const indexes = parseIndexes(req.query.indexes);
    if (!indexes.length) {
      res.status(400).json({ error: "indexes_required" });
      return;
    }
    try {
      const view = await loadPublicView(params.imageJobs, jobId);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const zip = new JSZip();
      for (const index of indexes) {
        const item = view.items[index];
        if (!item?.asset?.url) continue;
        const data = await fetchAssetBytes(fetchImpl, item.asset.url);
        zip.file(filenameForJobItem(jobId, item), data);
      }
      const files = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
      if (!files.length) {
        res.status(404).json({ error: "no_downloadable_assets" });
        return;
      }
      const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      const short = jobId.replace(/^wj_job_/, "").slice(0, 8);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="wj-job-${short}.zip"`);
      res.status(200).send(body);
    } catch (error) {
      params.logger.error({ err: error, jobId }, "public zip download failed");
      if (!res.headersSent) res.status(502).json({ error: "upstream_fetch_failed" });
    }
  });

  return router;
}

async function loadPublicView(
  imageJobs: ImageJobStore,
  jobId: string,
): Promise<PublicImageJobView | undefined> {
  const record = await imageJobs.getByJobId(jobId);
  return record ? toPublicImageJobView(record) : undefined;
}

function parseIndexes(raw: unknown): number[] {
  const text = Array.isArray(raw) ? raw.map(String).join(",") : String(raw ?? "");
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of text.split(",")) {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value < 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 20);
}

function allow(req: Request, buckets: Map<string, RateBucket>): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const current = buckets.get(ip);
  if (!current || current.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + LOOKUP_WINDOW_MS });
    return true;
  }
  if (current.count >= LOOKUP_LIMIT) return false;
  current.count += 1;
  return true;
}

async function fetchAssetBytes(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function pipeAssetDownload(
  fetchImpl: typeof fetch,
  item: PublicJobItem,
  filename: string,
  res: Response,
  logger: AppLogger,
): Promise<void> {
  const url = item.asset!.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      res.status(502).json({ error: "upstream_fetch_failed" });
      return;
    }
    const mime = item.asset?.mime_type
      || response.headers.get("content-type")?.split(";")[0]?.trim()
      || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const length = response.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    const bytes = Buffer.from(await response.arrayBuffer());
    res.status(200).send(bytes);
  } catch (error) {
    logger.warn({ err: error, url }, "asset proxy fetch failed");
    if (!res.headersSent) res.status(502).json({ error: "upstream_fetch_failed" });
  } finally {
    clearTimeout(timer);
  }
}

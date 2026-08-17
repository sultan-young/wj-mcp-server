import type { ImageJobRecord, ImageJobStatus, ImageJobProgress } from "./image-job-store.js";
import { computeProgress } from "./image-job-store.js";

export type PublicJobItemStatus = "ready" | "failed" | "pending";

export type PublicJobItem = {
  index: number;
  prompt: string;
  status: PublicJobItemStatus;
  error?: string;
  asset?: {
    url: string;
    mime_type?: string;
    width?: number;
    height?: number;
    duration_ms?: number;
  };
};

export type PublicImageJobMeta = {
  /** Shared reference images for the whole job (from gpt_reference_images). */
  referenceImageUrls: string[];
};

export type PublicImageJobView = {
  jobId: string;
  status: ImageJobStatus;
  model: string;
  resolution: string;
  aspectRatio: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
  durationMs?: number;
  progress: ImageJobProgress;
  meta: PublicImageJobMeta;
  items: PublicJobItem[];
};

const JOB_ID_RE = /^wj_job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPublicJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId.trim());
}

function readReferenceImageUrls(record: ImageJobRecord): string[] {
  const refs = record.input.gpt_reference_images ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const file of refs) {
    const url = file.download_url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Public snapshot: prompts, assets, and shared reference image URLs (no subject). */
export function toPublicImageJobView(record: ImageJobRecord): PublicImageJobView {
  const prompts = record.input.prompts;
  const total = Math.max(record.promptTotal, prompts.length);
  const assetByIndex = new Map<number, ImageJobRecord["assets"][number]>();
  for (const [order, asset] of record.assets.entries()) {
    assetByIndex.set(asset.prompt_index ?? order, asset);
  }
  const failureByIndex = new Map(record.failures.map((item) => [item.index, item.error]));
  const terminal = record.status === "failed" || record.status === "timed_out" || record.status === "completed";

  const items: PublicJobItem[] = Array.from({ length: total }, (_, index) => {
    const prompt = prompts[index] ?? "";
    const asset = assetByIndex.get(index);
    if (asset) {
      return {
        index,
        prompt,
        status: "ready" as const,
        asset: {
          url: asset.url,
          ...(asset.mime_type ? { mime_type: asset.mime_type } : {}),
          ...(asset.width ? { width: asset.width } : {}),
          ...(asset.height ? { height: asset.height } : {}),
          ...(asset.duration_ms === undefined ? {} : { duration_ms: asset.duration_ms }),
        },
      };
    }
    if (failureByIndex.has(index)) {
      return {
        index,
        prompt,
        status: "failed" as const,
        error: failureByIndex.get(index),
      };
    }
    if (terminal) {
      return {
        index,
        prompt,
        status: "failed" as const,
        error: record.error ?? "生成失败",
      };
    }
    return { index, prompt, status: "pending" as const };
  });

  return {
    jobId: record.jobId,
    status: record.status,
    model: record.model,
    resolution: record.resolution,
    aspectRatio: record.aspectRatio,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    progress: computeProgress(record),
    meta: {
      referenceImageUrls: readReferenceImageUrls(record),
    },
    items,
    ...(record.error ? { error: record.error } : {}),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
  };
}

export function extensionForMime(mimeType: string | undefined): string {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

export function filenameForJobItem(jobId: string, item: PublicJobItem): string {
  const short = jobId.replace(/^wj_job_/, "").slice(0, 8);
  const ext = extensionForMime(item.asset?.mime_type);
  return `${short}_${String(item.index + 1).padStart(2, "0")}.${ext}`;
}

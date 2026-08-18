import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RedisClient } from "./redis.js";
import { storedGenerateImageInputSchema, imageAssetSchema, type GenerateImageInput } from "./wj/types.js";

const JOB_KEY_PREFIX = "wj:mcp:image-job:";

export const imageJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "timed_out"]);

export const imagePromptFailureSchema = z.object({
  index: z.number().int().nonnegative(),
  error: z.string().min(1),
});

export const imageJobProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

export const imageJobRecordSchema = z.object({
  jobId: z.string().min(1),
  subject: z.string().min(1),
  terminalId: z.string().min(1),
  status: imageJobStatusSchema,
  model: z.string(),
  resolution: z.string(),
  aspectRatio: z.string(),
  promptTotal: z.number().int().positive(),
  input: storedGenerateImageInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema).default([]),
  failures: z.array(imagePromptFailureSchema).default([]),
});

export type ImageJobRecord = z.infer<typeof imageJobRecordSchema>;
export type ImageJobStatus = z.infer<typeof imageJobStatusSchema>;
export type ImagePromptFailure = z.infer<typeof imagePromptFailureSchema>;
export type ImageJobProgress = z.infer<typeof imageJobProgressSchema>;

/** Public job snapshot returned to MCP clients / widget (no raw input). */
export type ImageJobView = {
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
  assets: z.infer<typeof imageAssetSchema>[];
  failures: ImagePromptFailure[];
  progress: ImageJobProgress;
};

export class ImageJobStore {
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: RedisClient,
    /** Working-window TTL while queued/running (default ~20 minutes). */
    private readonly jobTtlSeconds: number,
    /** Retention TTL after completion (default ~30 days). */
    private readonly durableTtlSeconds: number,
  ) {}

  async create(params: {
    subject: string;
    terminalId: string;
    input: GenerateImageInput;
  }): Promise<ImageJobRecord> {
    const now = new Date();
    const jobId = `wj_job_${randomUUID()}`;
    const record = imageJobRecordSchema.parse({
      jobId,
      subject: params.subject,
      terminalId: params.terminalId,
      status: "queued",
      model: params.input.model,
      resolution: params.input.resolution,
      aspectRatio: params.input.aspect_ratio,
      promptTotal: params.input.prompts.length,
      input: params.input,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.jobTtlSeconds * 1000).toISOString(),
      assets: [],
      failures: [],
    });
    await this.write(record, this.jobTtlSeconds);
    return record;
  }

  async get(subject: string, jobId: string): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record || record.subject !== subject) return undefined;
    return await this.expireIfNeeded(record);
  }

  /** Public lookup by jobId only (no subject check). */
  async getByJobId(jobId: string): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record) return undefined;
    return await this.expireIfNeeded(record);
  }

  async markRunning(jobId: string): Promise<ImageJobRecord | undefined> {
    return this.enqueueWrite(jobId, async () => {
      const record = await this.read(jobId);
      if (!record) return undefined;
      if (record.status !== "queued" && record.status !== "running") return record;
      const current = await this.expireIfNeeded(record);
      if (!current || current.status === "timed_out") return current;
      const next = imageJobRecordSchema.parse({
        ...current,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      await this.write(next, this.remainingTtlSeconds(next.expiresAt, this.jobTtlSeconds));
      return next;
    });
  }

  /** Record one prompt outcome while the job is still running (progressive display). */
  async appendPromptOutcome(
    jobId: string,
    outcome: {
      index: number;
      asset?: ImageJobRecord["assets"][number];
      failure?: ImagePromptFailure;
      model?: string;
      resolution?: string;
      aspectRatio?: string;
    },
  ): Promise<ImageJobRecord | undefined> {
    return this.enqueueWrite(jobId, async () => {
      const record = await this.read(jobId);
      if (!record) return undefined;
      if (record.status === "timed_out" || record.status === "failed" || record.status === "completed") {
        return record;
      }

      const assets = [...record.assets];
      const failures = [...record.failures];

      if (outcome.asset) {
        const withIndex = {
          ...outcome.asset,
          prompt_index: outcome.asset.prompt_index ?? outcome.index,
        };
        const existing = assets.findIndex((asset) => asset.prompt_index === withIndex.prompt_index);
        if (existing >= 0) assets[existing] = withIndex;
        else assets.push(withIndex);
        assets.sort((a, b) => (a.prompt_index ?? 0) - (b.prompt_index ?? 0));
      }

      if (outcome.failure) {
        const existing = failures.findIndex((item) => item.index === outcome.failure!.index);
        if (existing >= 0) failures[existing] = outcome.failure;
        else failures.push(outcome.failure);
        failures.sort((a, b) => a.index - b.index);
      }

      const next = imageJobRecordSchema.parse({
        ...record,
        status: "running",
        model: outcome.model ?? record.model,
        resolution: outcome.resolution ?? record.resolution,
        aspectRatio: outcome.aspectRatio ?? record.aspectRatio,
        assets,
        failures,
        updatedAt: new Date().toISOString(),
      });
      await this.write(next, this.remainingTtlSeconds(next.expiresAt, this.jobTtlSeconds));
      return next;
    });
  }

  /** Replace ChatGPT temporary reference download_urls with durable WJ media URLs. */
  async replaceReferenceDownloadUrls(
    jobId: string,
    urls: string[],
  ): Promise<ImageJobRecord | undefined> {
    return this.enqueueWrite(jobId, async () => {
      const record = await this.read(jobId);
      if (!record) return undefined;
      const refs = record.input.gpt_reference_images;
      if (!refs?.length || !urls.length) return record;

      const nextRefs = refs.map((file, index) => {
        const nextUrl = urls[index]?.trim();
        if (!nextUrl) return file;
        return {
          ...file,
          download_url: nextUrl,
        };
      });

      const next = imageJobRecordSchema.parse({
        ...record,
        input: {
          ...record.input,
          gpt_reference_images: nextRefs,
        },
        updatedAt: new Date().toISOString(),
      });
      await this.write(next, this.remainingTtlSeconds(next.expiresAt, this.jobTtlSeconds));
      return next;
    });
  }

  async complete(
    jobId: string,
    payload: {
      assets: ImageJobRecord["assets"];
      failures?: ImagePromptFailure[];
      model: string;
      resolution: string;
      aspectRatio: string;
      durationMs?: number;
      error?: string;
    },
  ): Promise<ImageJobRecord | undefined> {
    return this.enqueueWrite(jobId, async () => {
      const record = await this.read(jobId);
      if (!record) return undefined;
      if (record.status === "timed_out" || record.status === "failed") return record;
      const now = new Date();
      const assets = [...payload.assets].sort(
        (a, b) => (a.prompt_index ?? 0) - (b.prompt_index ?? 0),
      );
      const next = imageJobRecordSchema.parse({
        ...record,
        status: "completed",
        model: payload.model,
        resolution: payload.resolution,
        aspectRatio: payload.aspectRatio,
        durationMs: payload.durationMs,
        assets,
        failures: payload.failures ?? [],
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.durableTtlSeconds * 1000).toISOString(),
        ...(payload.error ? { error: payload.error } : { error: undefined }),
      });
      await this.write(next, this.durableTtlSeconds);
      return next;
    });
  }

  async fail(jobId: string, error: string): Promise<ImageJobRecord | undefined> {
    return this.enqueueWrite(jobId, async () => {
      const record = await this.read(jobId);
      if (!record) return undefined;
      if (record.status === "completed" || record.status === "timed_out") return record;
      const next = imageJobRecordSchema.parse({
        ...record,
        status: "failed",
        error,
        updatedAt: new Date().toISOString(),
      });
      await this.write(next, this.remainingTtlSeconds(next.expiresAt, this.jobTtlSeconds));
      return next;
    });
  }

  toView(record: ImageJobRecord): ImageJobView {
    return {
      jobId: record.jobId,
      status: record.status,
      model: record.model,
      resolution: record.resolution,
      aspectRatio: record.aspectRatio,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      assets: record.assets,
      failures: record.failures ?? [],
      progress: computeProgress(record),
      ...(record.error ? { error: record.error } : {}),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    };
  }

  /** Fingerprint of status/progress/assets for change detection. */
  viewFingerprint(view: ImageJobView): string {
    return [
      view.status,
      view.progress.succeeded,
      view.progress.failed,
      view.progress.pending,
      view.assets.map((asset) => asset.url).join("|"),
      view.error ?? "",
    ].join(":");
  }

  /** Serialize Redis read-modify-write mutations for one job. */
  private enqueueWrite<T>(jobId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(jobId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(op);
    this.writeChains.set(
      jobId,
      run.then(() => undefined, () => undefined),
    );
    return run;
  }

  private async expireIfNeeded(record: ImageJobRecord): Promise<ImageJobRecord | undefined> {
    if (Date.parse(record.expiresAt) > Date.now()) return record;

    if (record.status === "queued" || record.status === "running") {
      const next = imageJobRecordSchema.parse({
        ...record,
        status: "timed_out",
        error: "Image job timed out after 20 minutes.",
        updatedAt: new Date().toISOString(),
      });
      await this.write(next, 60);
      return next;
    }

    await this.redis.del(`${JOB_KEY_PREFIX}${record.jobId}`);
    return undefined;
  }

  private async read(jobId: string): Promise<ImageJobRecord | undefined> {
    const raw = await this.redis.get(`${JOB_KEY_PREFIX}${jobId}`);
    if (!raw) return undefined;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = imageJobRecordSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : undefined;
  }

  private async write(record: ImageJobRecord, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await this.redis.set(`${JOB_KEY_PREFIX}${record.jobId}`, JSON.stringify(record), { EX: ttl });
  }

  private remainingTtlSeconds(expiresAt: string, fallback: number): number {
    const remaining = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000);
    return Math.max(1, Number.isFinite(remaining) ? remaining : fallback);
  }
}

export function computeProgress(record: Pick<ImageJobRecord, "promptTotal" | "assets" | "failures" | "status">): ImageJobProgress {
  const succeeded = record.assets.length;
  const failed = record.failures.length;
  const settled = succeeded + failed;
  const pending = record.status === "completed" || record.status === "failed" || record.status === "timed_out"
    ? 0
    : Math.max(0, record.promptTotal - settled);
  return {
    total: record.promptTotal,
    succeeded,
    failed,
    pending,
  };
}

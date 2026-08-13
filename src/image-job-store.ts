import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RedisClient } from "./redis.js";
import { generateImageInputSchema, imageAssetSchema, type GenerateImageInput } from "./wj/types.js";

const JOB_KEY_PREFIX = "wj:mcp:image-job:";

export const imageJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "timed_out"]);

export const imagePromptFailureSchema = z.object({
  index: z.number().int().nonnegative(),
  error: z.string().min(1),
});

export const imageJobRecordSchema = z.object({
  jobId: z.string().min(1),
  subject: z.string().min(1),
  terminalId: z.string().min(1),
  status: imageJobStatusSchema,
  model: z.string(),
  resolution: z.string(),
  aspectRatio: z.string(),
  input: generateImageInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema).default([]),
  failures: z.array(imagePromptFailureSchema).default([]),
  resultId: z.string().optional(),
  resultCreatedAt: z.string().datetime().optional(),
  resultExpiresAt: z.string().datetime().optional(),
});

export type ImageJobRecord = z.infer<typeof imageJobRecordSchema>;
export type ImageJobStatus = z.infer<typeof imageJobStatusSchema>;
export type ImagePromptFailure = z.infer<typeof imagePromptFailureSchema>;

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
  resultId?: string;
  resultCreatedAt?: string;
  resultExpiresAt?: string;
};

export class ImageJobStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number,
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
      input: params.input,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
      assets: [],
      failures: [],
    });
    await this.write(record);
    return record;
  }

  async get(subject: string, jobId: string): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record || record.subject !== subject) return undefined;
    return await this.expireIfNeeded(record);
  }

  async markRunning(jobId: string): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record) return undefined;
    if (record.status !== "queued" && record.status !== "running") return record;
    const expired = await this.expireIfNeeded(record);
    if (expired.status === "timed_out") return expired;
    const next = imageJobRecordSchema.parse({
      ...expired,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    await this.write(next);
    return next;
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
      resultId?: string;
      resultCreatedAt?: string;
      resultExpiresAt?: string;
      error?: string;
    },
  ): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record) return undefined;
    if (record.status === "timed_out" || record.status === "failed") return record;
    const next = imageJobRecordSchema.parse({
      ...record,
      status: "completed",
      model: payload.model,
      resolution: payload.resolution,
      aspectRatio: payload.aspectRatio,
      durationMs: payload.durationMs,
      assets: payload.assets,
      failures: payload.failures ?? [],
      resultId: payload.resultId,
      resultCreatedAt: payload.resultCreatedAt,
      resultExpiresAt: payload.resultExpiresAt,
      updatedAt: new Date().toISOString(),
      ...(payload.error ? { error: payload.error } : { error: undefined }),
    });
    await this.write(next);
    return next;
  }

  async fail(jobId: string, error: string): Promise<ImageJobRecord | undefined> {
    const record = await this.read(jobId);
    if (!record) return undefined;
    if (record.status === "completed" || record.status === "timed_out") return record;
    const next = imageJobRecordSchema.parse({
      ...record,
      status: "failed",
      error,
      updatedAt: new Date().toISOString(),
    });
    await this.write(next);
    return next;
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
      ...(record.error ? { error: record.error } : {}),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      ...(record.resultId ? { resultId: record.resultId } : {}),
      ...(record.resultCreatedAt ? { resultCreatedAt: record.resultCreatedAt } : {}),
      ...(record.resultExpiresAt ? { resultExpiresAt: record.resultExpiresAt } : {}),
    };
  }

  private async expireIfNeeded(record: ImageJobRecord): Promise<ImageJobRecord> {
    if (record.status !== "queued" && record.status !== "running") return record;
    if (Date.parse(record.expiresAt) > Date.now()) return record;
    const next = imageJobRecordSchema.parse({
      ...record,
      status: "timed_out",
      error: "Image job timed out after 20 minutes.",
      updatedAt: new Date().toISOString(),
    });
    await this.write(next);
    return next;
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

  private async write(record: ImageJobRecord): Promise<void> {
    const remainingSeconds = Math.max(1, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1000));
    // Keep completed/failed records until the original job window ends (or a short grace after).
    const ttl = Math.max(remainingSeconds, 60);
    await this.redis.set(`${JOB_KEY_PREFIX}${record.jobId}`, JSON.stringify(record), { EX: ttl });
  }
}

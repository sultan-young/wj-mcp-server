import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RedisClient } from "./redis.js";
import { imageAssetSchema } from "./wj/types.js";

const RESULT_KEY_PREFIX = "wj:mcp:image-result:";

export const persistedImageResultSchema = z.object({
  model: z.string(),
  resolution: z.string(),
  aspectRatio: z.string(),
  durationMs: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema).min(1),
  resultId: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const storedRecordSchema = z.object({
  subject: z.string().min(1),
  result: persistedImageResultSchema,
});

export type PersistedImageResult = z.infer<typeof persistedImageResultSchema>;
export type ImageResultData = Omit<PersistedImageResult, "resultId" | "createdAt" | "expiresAt">;

export class ImageResultStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number,
  ) {}

  async save(subject: string, result: ImageResultData): Promise<PersistedImageResult> {
    const resultId = `wj_img_${randomUUID()}`;
    const createdAt = new Date();
    const persisted = persistedImageResultSchema.parse({
      ...result,
      resultId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlSeconds * 1000).toISOString(),
    });
    await this.redis.set(
      `${RESULT_KEY_PREFIX}${resultId}`,
      JSON.stringify({ subject, result: persisted }),
      { EX: this.ttlSeconds },
    );
    return persisted;
  }

  async get(subject: string, resultId: string): Promise<PersistedImageResult | undefined> {
    const raw = await this.redis.get(`${RESULT_KEY_PREFIX}${resultId}`);
    if (!raw) return undefined;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }

    const record = storedRecordSchema.safeParse(parsedJson);
    if (!record.success || record.data.subject !== subject) return undefined;
    if (Date.parse(record.data.result.expiresAt) <= Date.now()) return undefined;
    return record.data.result;
  }
}

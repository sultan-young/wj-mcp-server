import pLimit from "p-limit";

import type { AppConfig } from "./config.js";
import { WjClient } from "./wj/client.js";
import {
  type GenerateImageInput,
  resolveGenerateJobs,
  type WjImageData,
} from "./wj/types.js";

export class GenerationService {
  private readonly queues = new Map<string, ReturnType<typeof pLimit>>();
  private readonly maxConcurrency: number;

  constructor(
    private readonly client: WjClient,
    config: AppConfig,
  ) {
    this.maxConcurrency = config.IMAGE_MAX_CONCURRENCY;
  }

  async generate(terminalId: string, input: GenerateImageInput): Promise<WjImageData> {
    const jobs = resolveGenerateJobs(input);
    const queue = this.getQueue(terminalId);
    try {
      if (jobs.length === 1) {
        return await queue(() => this.client.generateImage(jobs[0]!));
      }

      const settled = await Promise.all(
        jobs.map((job) => queue(() => this.client.generateImage(job))),
      );
      return mergeGeneratedImages(settled);
    } finally {
      queueMicrotask(() => {
        if (queue.activeCount === 0 && queue.pendingCount === 0 && this.queues.get(terminalId) === queue) {
          this.queues.delete(terminalId);
        }
      });
    }
  }

  private getQueue(terminalId: string): ReturnType<typeof pLimit> {
    const existing = this.queues.get(terminalId);
    if (existing) return existing;

    const queue = pLimit(this.maxConcurrency);
    this.queues.set(terminalId, queue);
    return queue;
  }
}

function mergeGeneratedImages(results: WjImageData[]): WjImageData {
  const durationValues = results
    .map((result) => result.duration_ms)
    .filter((value): value is number => value !== undefined);
  return {
    model_id: results[0]?.model_id ?? "unknown",
    resolution: results[0]?.resolution,
    aspect_ratio: results[0]?.aspect_ratio,
    ...(durationValues.length
      ? { duration_ms: durationValues.reduce((sum, value) => sum + value, 0) }
      : {}),
    assets: results.flatMap((result) => result.assets),
  };
}

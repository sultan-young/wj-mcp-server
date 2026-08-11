import pLimit from "p-limit";

import type { AppConfig } from "./config.js";
import { WjClient } from "./wj/client.js";
import type { GenerateImageInput, WjImageData } from "./wj/types.js";

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
    const queue = this.getQueue(terminalId);
    try {
      return await queue(() => this.client.generateImage(input));
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

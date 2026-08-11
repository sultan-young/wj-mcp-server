import pLimit from "p-limit";

import type { AppConfig } from "./config.js";
import type { UsageLimits } from "./limits.js";
import { WjClient } from "./wj/client.js";
import type { GenerateImageRequest, WjImageData } from "./wj/types.js";

export class GenerationService {
  private readonly queue;

  constructor(
    private readonly client: WjClient,
    private readonly limits: UsageLimits,
    config: AppConfig,
  ) {
    this.queue = pLimit(config.IMAGE_MAX_CONCURRENCY);
  }

  async generate(subject: string, input: GenerateImageRequest): Promise<WjImageData> {
    await this.limits.consumeImage(subject);
    return this.queue(() => this.client.generateImage(input));
  }
}

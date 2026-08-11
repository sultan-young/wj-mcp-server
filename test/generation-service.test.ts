import { describe, expect, it, vi } from "vitest";

import { GenerationService } from "../src/generation-service.js";
import type { UsageLimits } from "../src/limits.js";
import type { WjClient } from "../src/wj/client.js";
import type { GenerateImageRequest } from "../src/wj/types.js";
import { testConfig } from "./helpers.js";

describe("GenerationService", () => {
  it("runs independent image requests concurrently up to the configured limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const generateImage = vi.fn(async (input: GenerateImageRequest) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        model_id: input.model,
        resolution: input.resolution,
        aspect_ratio: input.aspect_ratio,
        assets: [{
          type: "image",
          mime_type: "image/png",
          url: `https://img.downk.cc/${encodeURIComponent(input.prompt)}.png`,
        }],
      };
    });
    const consumeImage = vi.fn().mockResolvedValue(undefined);
    const service = new GenerationService(
      { generateImage } as unknown as WjClient,
      { consumeImage } as unknown as UsageLimits,
      testConfig({ IMAGE_MAX_CONCURRENCY: "2" }),
    );
    const request = (index: number): GenerateImageRequest => ({
      prompt: `image-${index}`,
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    });

    await Promise.all(Array.from({ length: 5 }, (_, index) => service.generate("subject", request(index))));

    expect(generateImage).toHaveBeenCalledTimes(5);
    expect(consumeImage).toHaveBeenCalledTimes(5);
    expect(maximumActive).toBe(2);
  });
});

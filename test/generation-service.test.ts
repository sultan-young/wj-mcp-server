import { describe, expect, it, vi } from "vitest";

import { GenerationService } from "../src/generation-service.js";
import type { WjClient } from "../src/wj/client.js";
import type { GenerateImageInput } from "../src/wj/types.js";
import { testConfig } from "./helpers.js";

describe("GenerationService", () => {
  it("runs independent image requests concurrently up to the configured limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const generateImage = vi.fn(async (input: GenerateImageInput) => {
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
    const service = new GenerationService(
      { generateImage } as unknown as WjClient,
      testConfig({ IMAGE_MAX_CONCURRENCY: "2" }),
    );
    const request = (index: number): GenerateImageInput => ({
      prompt: `image-${index}`,
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    });

    await Promise.all(Array.from({ length: 5 }, (_, index) => service.generate("subject", request(index))));

    expect(generateImage).toHaveBeenCalledTimes(5);
    expect(maximumActive).toBe(2);
  });

  it("uses an independent concurrency queue for each OAuth terminal", async () => {
    let activeTotal = 0;
    let maximumTotal = 0;
    const activeByTerminal = new Map<string, number>();
    const maximumByTerminal = new Map<string, number>();
    const generateImage = vi.fn(async (input: GenerateImageInput) => {
      const terminalId = input.prompt.split(":", 1)[0]!;
      const activeForTerminal = (activeByTerminal.get(terminalId) ?? 0) + 1;
      activeByTerminal.set(terminalId, activeForTerminal);
      maximumByTerminal.set(terminalId, Math.max(maximumByTerminal.get(terminalId) ?? 0, activeForTerminal));
      activeTotal += 1;
      maximumTotal = Math.max(maximumTotal, activeTotal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeTotal -= 1;
      activeByTerminal.set(terminalId, activeForTerminal - 1);
      return {
        model_id: input.model,
        resolution: input.resolution,
        aspect_ratio: input.aspect_ratio,
        assets: [{ type: "image", mime_type: "image/png", url: `https://img.downk.cc/${input.prompt}.png` }],
      };
    });
    const service = new GenerationService(
      { generateImage } as unknown as WjClient,
      testConfig({ IMAGE_MAX_CONCURRENCY: "2" }),
    );
    const request = (terminalId: string, index: number): GenerateImageInput => ({
      prompt: `${terminalId}:${index}`,
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    });

    await Promise.all([
      ...Array.from({ length: 3 }, (_, index) => service.generate("terminal-a", request("terminal-a", index))),
      ...Array.from({ length: 3 }, (_, index) => service.generate("terminal-b", request("terminal-b", index))),
    ]);

    expect(maximumByTerminal.get("terminal-a")).toBe(2);
    expect(maximumByTerminal.get("terminal-b")).toBe(2);
    expect(maximumTotal).toBe(4);
  });
});

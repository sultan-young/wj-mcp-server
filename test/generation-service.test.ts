import { describe, expect, it, vi } from "vitest";

import type { GenerateImageInput, WjGenerateImageRequest } from "../src/wj/types.js";
import { testGenerationService } from "./helpers.js";

describe("GenerationService", () => {
  it("runs independent image requests concurrently up to the configured limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const generateImage = vi.fn(async (input: WjGenerateImageRequest) => {
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
    const service = testGenerationService({ generateImage }, { IMAGE_MAX_CONCURRENCY: "2" });
    const request = (index: number): GenerateImageInput => ({
      prompts: [`image-${index}`],
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
    const generateImage = vi.fn(async (input: WjGenerateImageRequest) => {
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
    const service = testGenerationService({ generateImage }, { IMAGE_MAX_CONCURRENCY: "2" });
    const request = (terminalId: string, index: number): GenerateImageInput => ({
      prompts: [`${terminalId}:${index}`],
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

  it("forwards ChatGPT gpt_reference_images download URLs to WJ", async () => {
    const generateImage = vi.fn().mockResolvedValue({
      model_id: "gpt-image-2",
      resolution: "2K",
      aspect_ratio: "1:1",
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/out.png" }],
    });
    const service = testGenerationService({ generateImage });

    await service.generate("terminal", {
      prompts: ["combine refs"],
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
      gpt_reference_images: [
        {
          download_url: "https://files.openai.example/a.png",
          file_id: "file_a",
        },
        {
          download_url: "https://files.openai.example/b.png",
          file_id: "file_b",
        },
      ],
    });

    expect(generateImage).toHaveBeenCalledWith({
      prompt: "combine refs",
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
      gpt_reference_images: [
        expect.objectContaining({ file_id: "file_a" }),
        expect.objectContaining({ file_id: "file_b" }),
      ],
    });
  });

  it("expands prompts into concurrent WJ jobs and merges assets", async () => {
    let active = 0;
    let maximumActive = 0;
    const generateImage = vi.fn(async (input: { prompt: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      const durationByPrompt: Record<string, number> = { one: 10, two: 20, three: 30 };
      return {
        model_id: "gpt-image-2",
        resolution: "2K",
        aspect_ratio: "1:1",
        duration_ms: durationByPrompt[input.prompt] ?? 10,
        assets: [{
          type: "image",
          mime_type: "image/png",
          url: `https://img.downk.cc/${encodeURIComponent(input.prompt)}.png`,
        }],
      };
    });
    const service = testGenerationService({ generateImage }, { IMAGE_MAX_CONCURRENCY: "2" });

    const result = await service.generate("terminal", {
      prompts: ["one", "two", "three"],
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    });

    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
    expect(result.assets).toHaveLength(3);
    expect(result.duration_ms).toBeUndefined();
    expect(result.assets.map((asset) => asset.duration_ms)).toEqual([10, 20, 30]);
    expect(result.assets.map((asset) => asset.url)).toEqual([
      "https://img.downk.cc/one.png",
      "https://img.downk.cc/two.png",
      "https://img.downk.cc/three.png",
    ]);
  });

  it("submits a job immediately and completes via polling", async () => {
    const generateImage = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        model_id: "gpt-image-2",
        resolution: "2K",
        aspect_ratio: "1:1",
        duration_ms: 30,
        assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/async.png" }],
      };
    });
    const service = testGenerationService({ generateImage });

    const accepted = await service.submit("subject", "terminal", {
      prompts: ["async city"],
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    });
    expect(accepted.jobId).toMatch(/^wj_job_/);
    expect(["queued", "running"]).toContain(accepted.status);
    expect(accepted.assets).toEqual([]);

    const completed = await service.pollJob("subject", accepted.jobId, 5_000);
    expect(completed?.status).toBe("completed");
    expect(completed?.assets).toEqual([
      expect.objectContaining({ url: "https://img.downk.cc/async.png" }),
    ]);
    expect(completed?.resultId).toMatch(/^wj_img_/);
  });
});

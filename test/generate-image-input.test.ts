import { describe, expect, it } from "vitest";

import {
  generateImageInputSchema,
  parseGenerateImageInput,
  resolveGenerateJobs,
} from "../src/wj/types.js";

describe("generateImageInputSchema", () => {
  it("accepts prompts with shared attachments", () => {
    const parsed = parseGenerateImageInput({
      prompts: ["edit the board", "another angle"],
      gpt_reference_images: [{
        download_url: "https://files.openai.example/a.png",
        file_id: "file_a",
      }],
    });
    expect(resolveGenerateJobs(parsed)).toEqual([
      expect.objectContaining({
        prompt: "edit the board",
        gpt_reference_images: [expect.objectContaining({ file_id: "file_a" })],
      }),
      expect.objectContaining({
        prompt: "another angle",
        gpt_reference_images: [expect.objectContaining({ file_id: "file_a" })],
      }),
    ]);
  });

  it("requires prompts with 1–10 entries", () => {
    expect(() => generateImageInputSchema.parse({})).toThrow();
    expect(() => generateImageInputSchema.parse({ prompts: [] })).toThrow();
    expect(resolveGenerateJobs(parseGenerateImageInput({ prompts: ["a"] })).map((job) => job.prompt)).toEqual(["a"]);
  });

  it("defaults resolution by model", () => {
    expect(parseGenerateImageInput({ prompts: ["a"] })).toMatchObject({
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "1K",
    });
    expect(parseGenerateImageInput({ prompts: ["a"], model: "gpt-image-2" }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "nano-banana-2" }).resolution).toBe("2K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "nano-banana-2", resolution: "1K" }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "gpt-image-2.5" }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "gpt-image-2.5-flare" }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "gpt-image-2.5-sunburst" }).resolution).toBe("1K");
  });

  it("accepts resolutions and ratios that wj-ai-server supports for that model", () => {
    expect(parseGenerateImageInput({
      prompts: ["a"],
      model: "nano-banana-2",
      resolution: "512",
      aspect_ratio: "21:9",
    })).toMatchObject({ resolution: "512", aspect_ratio: "21:9" });
    expect(parseGenerateImageInput({
      prompts: ["a"],
      model: "gpt-image-2",
      resolution: "4K",
      aspect_ratio: "1:3",
    })).toMatchObject({ resolution: "4K", aspect_ratio: "1:3" });
    expect(parseGenerateImageInput({
      prompts: ["a"],
      model: "gpt-image-2.5-sunburst",
      aspect_ratio: "auto",
    }).aspect_ratio).toBe("auto");
  });

  it("rejects a resolution or ratio the selected model does not support", () => {
    expect(() => parseGenerateImageInput({
      prompts: ["a"],
      model: "gpt-image-2.5",
      resolution: "2K",
    })).toThrow(/resolution 2K is not supported for gpt-image-2\.5/);
    expect(() => parseGenerateImageInput({
      prompts: ["a"],
      model: "nano-banana-2",
      aspect_ratio: "1:2",
    })).toThrow(/aspect_ratio 1:2 is not supported for nano-banana-2/);
    expect(() => parseGenerateImageInput({
      prompts: ["a"],
      model: "gpt-image-2.5",
      aspect_ratio: "1:3",
    })).toThrow(/aspect_ratio 1:3 is not supported for gpt-image-2\.5/);
  });
});

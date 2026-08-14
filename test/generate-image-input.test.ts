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
    expect(parseGenerateImageInput({ prompts: ["a"] }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "gpt-image-2" }).resolution).toBe("1K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "nano-banana-2" }).resolution).toBe("2K");
    expect(parseGenerateImageInput({ prompts: ["a"], model: "nano-banana-2", resolution: "1K" }).resolution).toBe("1K");
  });
});

import { describe, expect, it } from "vitest";

import { createPersistedImageState, getImageResult } from "../ui/image-result-state.js";

const imageResult = {
  model: "gpt-image-2",
  resolution: "2K",
  aspectRatio: "1:1",
  assets: [{ url: "https://img.downk.cc/generated.png", mime_type: "image/png" }],
};

describe("image result state", () => {
  it("reads a direct tool output", () => {
    expect(getImageResult(imageResult)).toEqual(imageResult);
  });

  it("restores a persisted widget result", () => {
    expect(getImageResult(createPersistedImageState(imageResult))).toEqual(imageResult);
  });

  it("reads the standard tool-result envelope", () => {
    expect(getImageResult({ structuredContent: imageResult })).toEqual(imageResult);
  });

  it("reads ChatGPT full response metadata fallbacks", () => {
    expect(getImageResult({
      mcp_tool_result: {
        structuredContent: imageResult,
      },
    })).toEqual(imageResult);
  });

  it("rejects incomplete persisted data", () => {
    expect(getImageResult({ privateContent: { version: 1 } })).toBeUndefined();
  });
});

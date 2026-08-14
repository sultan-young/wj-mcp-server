import { describe, expect, it } from "vitest";

import { appendWjCallData, extractWjCallData, formatWjCallData } from "../src/wj/call-data.js";

describe("WJ call_data", () => {
  it("reads meta.call_data from a WJ error body", () => {
    expect(extractWjCallData({
      success: false,
      error: { code: "upstream_error", message: "quota exceeded" },
      meta: {
        call_data: {
          call_id: "b980db26-9512-45cc-b1da-c511a363b83f",
          model_id: "7c9f2a1b3d8e4f0a2c6b5d9e1f3a7b8c",
          model_api_base: "https://api.openai.com/v1",
          duration_ms: 842,
        },
      },
    })).toEqual({
      call_id: "b980db26-9512-45cc-b1da-c511a363b83f",
      model_id: "7c9f2a1b3d8e4f0a2c6b5d9e1f3a7b8c",
      model_api_base: "https://api.openai.com/v1",
      duration_ms: 842,
    });
  });

  it("formats diagnostics for failed jobs", () => {
    expect(formatWjCallData({
      call_id: "abc",
      model_id: "dep-1",
      model_api_base: "https://api.openai.com/v1",
    })).toBe("call_id=abc  model_id=dep-1  model_api_base=https://api.openai.com/v1");
    expect(appendWjCallData("quota exceeded", {
      call_id: "abc",
      model_id: "dep-1",
    })).toBe("quota exceeded\ncall_id=abc  model_id=dep-1");
  });

  it("omits empty call_data", () => {
    expect(extractWjCallData({ success: false, error: { message: "busy" } })).toBeUndefined();
    expect(formatWjCallData({})).toBeUndefined();
    expect(appendWjCallData("busy", undefined)).toBe("busy");
  });
});

import { describe, expect, it, vi } from "vitest";

import { WjClient } from "../src/wj/client.js";
import { testConfig, testLogger } from "./helpers.js";

describe("WjClient", () => {
  it("calls the public WJ image endpoint with the server-side bearer key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        model_id: "gpt-image-2",
        resolution: "1K",
        aspect_ratio: "16:9",
        duration_ms: 1200,
        assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/test.png", width: 1536, height: 864 }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    const result = await client.generateImage({
      model: "gpt-image-2",
      prompt: "A red paper lantern in rain",
      aspect_ratio: "16:9",
      resolution: "1K",
    });

    expect(result.assets[0]?.url).toBe("https://img.downk.cc/test.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://wj.example.com/api/v1/proxy/ai/generate/image");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer wj_test_secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "A red paper lantern in rain",
      output: { aspect_ratio: "16:9", resolution: "1K" },
      response_format: "url",
    });
  });

  it("does not retry a non-idempotent generation request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "busy" }), { status: 503 }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    await expect(client.generateImage({
      model: "gpt-image-2",
      prompt: "test",
      aspect_ratio: "1:1",
      resolution: "1K",
    })).rejects.toEqual(expect.objectContaining({ status: 503, message: "busy" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards ChatGPT attachment download URLs as WJ input_images", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        model_id: "gpt-image-2",
        resolution: "1K",
        aspect_ratio: "1:1",
        assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/edited.png" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    await client.generateImage({
      model: "gpt-image-2",
      prompt: "Copy the name from image two onto image one",
      aspect_ratio: "1:1",
      resolution: "1K",
      reference_image_urls: [
        "https://files.openai.example/target.png?signature=one",
        "https://files.openai.example/reference.png?signature=two",
      ],
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      input_images: [
        "https://files.openai.example/target.png?signature=one",
        "https://files.openai.example/reference.png?signature=two",
      ],
    }));
  });
});

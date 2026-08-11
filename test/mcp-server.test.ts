import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationService } from "../src/generation-service.js";
import { ImageResultStore } from "../src/image-result-store.js";
import { createWjMcpServer, IMAGE_WIDGET_URI, WJ_IMAGE_SERVER_INSTRUCTIONS } from "../src/mcp/server.js";
import type { RedisClient } from "../src/redis.js";
import { WjApiError } from "../src/wj/client.js";
import { testConfig, testImageResultStore, testLogger } from "./helpers.js";

describe("WJ MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("advertises and calls image generation and private-attachment editing tools", async () => {
    const generate = vi.fn().mockResolvedValue({
      model_id: "gpt-image-2",
      resolution: "2K",
      aspect_ratio: "1:1",
      duration_ms: 900,
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/generated.png", width: 1024, height: 1024 }],
    });
    const generation = { generate } as unknown as GenerationService;
    const imageResults = testImageResultStore();
    const server = createWjMcpServer({ config: testConfig(), generation, imageResults, logger: testLogger(), widgetHtml: "<!doctype html><p>widget</p>" });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    expect(client.getInstructions()).toBe(WJ_IMAGE_SERVER_INSTRUCTIONS);

    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "generate_image");
    const batchTool = tools.tools.find((item) => item.name === "generate_images");
    const editTool = tools.tools.find((item) => item.name === "edit_image");
    const recoveryTool = tools.tools.find((item) => item.name === "get_image_result");
    expect(tool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?._meta?.["openai/outputTemplate"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    expect(tool?.inputSchema.properties).toEqual(expect.objectContaining({
      count: expect.objectContaining({ maximum: 8, minimum: 1 }),
    }));
    expect(tool?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["wj:image"] }]);
    expect(batchTool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(batchTool?.inputSchema).toEqual(expect.objectContaining({
      type: "object",
      required: ["requests"],
      properties: expect.objectContaining({
        requests: expect.objectContaining({ type: "array", minItems: 2, maxItems: 8 }),
      }),
    }));
    expect(editTool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(editTool?._meta?.["openai/fileParams"]).toEqual(["target_image", "reference_images"]);
    expect(editTool?.inputSchema).toEqual(expect.objectContaining({
      type: "object",
      required: expect.arrayContaining(["prompt", "target_image"]),
      properties: expect.objectContaining({
        target_image: expect.objectContaining({ type: "object" }),
        reference_images: expect.objectContaining({ type: "array" }),
      }),
    }));
    const editProperties = editTool?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
    const targetImageSchema = editProperties?.target_image;
    const referenceImagesSchema = editProperties?.reference_images;
    expect(targetImageSchema).toEqual(expect.objectContaining({
      additionalProperties: false,
      required: ["download_url", "file_id"],
      properties: expect.objectContaining({
        download_url: expect.objectContaining({ type: "string" }),
        file_id: expect.objectContaining({ type: "string" }),
        mime_type: expect.objectContaining({ type: "string" }),
        file_name: expect.objectContaining({ type: "string" }),
      }),
    }));
    expect(referenceImagesSchema?.items).toEqual(expect.objectContaining({
      additionalProperties: false,
      required: ["download_url", "file_id"],
      properties: expect.objectContaining({
        download_url: expect.objectContaining({ type: "string" }),
        file_id: expect.objectContaining({ type: "string" }),
        mime_type: expect.objectContaining({ type: "string" }),
        file_name: expect.objectContaining({ type: "string" }),
      }),
    }));
    expect(recoveryTool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(recoveryTool?.annotations).toEqual(expect.objectContaining({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }));

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A quiet futuristic city" },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({
      model: "gpt-image-2",
      requestedCount: 1,
      completedCount: 1,
      failedCount: 0,
      resultId: expect.stringMatching(/^wj_img_/),
      expiresAt: expect.any(String),
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(response.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringContaining("https://img.downk.cc/generated.png"),
    })]);
    expect(response.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_link" }),
    ]));
    expect(generate).toHaveBeenCalledWith("wj-shared-access", expect.objectContaining({
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    }));

    const generatedResultId = (response.structuredContent as { resultId: string }).resultId;
    const generateCallsBeforeRecovery = generate.mock.calls.length;
    const recoveredResponse = await client.callTool({
      name: "get_image_result",
      arguments: { result_id: generatedResultId },
    });
    expect(recoveredResponse.isError).not.toBe(true);
    expect(recoveredResponse.structuredContent).toEqual(expect.objectContaining({
      resultId: generatedResultId,
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(generate).toHaveBeenCalledTimes(generateCallsBeforeRecovery);

    await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A small explicit-resolution image", resolution: "1K" },
    });
    expect(generate).toHaveBeenNthCalledWith(2, "wj-shared-access", expect.objectContaining({
      resolution: "1K",
    }));

    const samePromptStart = generate.mock.calls.length;
    const samePromptResponse = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "Five variations of the same red chair", count: 5 },
    });
    const samePromptCalls = generate.mock.calls.slice(samePromptStart);
    expect(samePromptCalls).toHaveLength(5);
    expect(samePromptCalls.every((call) => call[1].prompt === "Five variations of the same red chair")).toBe(true);
    expect(samePromptResponse.structuredContent).toEqual(expect.objectContaining({
      requestedCount: 5,
      completedCount: 5,
      failedCount: 0,
      assets: expect.arrayContaining([expect.objectContaining({ url: "https://img.downk.cc/generated.png" })]),
    }));
    expect((samePromptResponse.structuredContent as { assets: unknown[] }).assets).toHaveLength(5);

    const differentPromptStart = generate.mock.calls.length;
    const differentPromptResponse = await client.callTool({
      name: "generate_images",
      arguments: {
        requests: [
          { prompt: "A red chair in a studio" },
          { prompt: "A blue bicycle in the rain" },
          { prompt: "A green teapot on a table" },
        ],
      },
    });
    const differentPromptCalls = generate.mock.calls.slice(differentPromptStart);
    expect(differentPromptCalls.map((call) => call[1].prompt)).toEqual([
      "A red chair in a studio",
      "A blue bicycle in the rain",
      "A green teapot on a table",
    ]);
    expect(differentPromptResponse.structuredContent).toEqual(expect.objectContaining({
      requestedCount: 3,
      completedCount: 3,
      failedCount: 0,
    }));
    expect((differentPromptResponse.structuredContent as { assets: unknown[] }).assets).toHaveLength(3);

    const editResponse = await client.callTool({
      name: "edit_image",
      arguments: {
        prompt: "Add the handwritten name from image two to the board in image one",
        target_image: {
          download_url: "https://files.openai.example/target.png?signature=one",
          file_id: "file_target",
          mime_type: "image/png",
          file_name: "target.png",
        },
        reference_images: [{
          download_url: "https://files.openai.example/reference.png?signature=two",
          file_id: "file_reference",
          mime_type: "image/png",
          file_name: "reference.png",
        }],
      },
    });
    expect(editResponse.isError).not.toBe(true);
    expect(editResponse.structuredContent).toEqual(expect.objectContaining({
      model: "gpt-image-2",
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(generate).toHaveBeenLastCalledWith("wj-shared-access", {
      prompt: "Add the handwritten name from image two to the board in image one",
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
      reference_image_urls: [
        "https://files.openai.example/target.png?signature=one",
        "https://files.openai.example/reference.png?signature=two",
      ],
    });

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual([IMAGE_WIDGET_URI]);
    expect(resources.resources[0]?._meta).toEqual(expect.objectContaining({
      ui: expect.objectContaining({
        domain: "http://127.0.0.1:6070",
      }),
    }));

    const resource = await client.readResource({ uri: IMAGE_WIDGET_URI });
    expect(resource.contents[0]).toEqual(expect.objectContaining({
      uri: IMAGE_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: "<!doctype html><p>widget</p>",
      _meta: expect.objectContaining({
        ui: expect.objectContaining({
          domain: "http://127.0.0.1:6070",
          csp: expect.objectContaining({
            resourceDomains: expect.arrayContaining(["https://img.downk.cc"]),
          }),
        }),
      }),
    }));
  });

  it("reports the actual WJ authorization failure instead of assuming the API key is invalid", async () => {
    const generation = {
      generate: vi.fn().mockRejectedValue(new WjApiError("authorization policy denied the request", 403)),
    } as unknown as GenerationService;
    const server = createWjMcpServer({ config: testConfig(), generation, imageResults: testImageResultStore(), logger: testLogger(), widgetHtml: "<!doctype html><p>widget</p>" });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A test image" },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{
      type: "text",
      text: "WJ request was rejected with HTTP 403: authorization policy denied the request",
    }]);
  });

  it("returns original links when result persistence is temporarily unavailable", async () => {
    const generation = {
      generate: vi.fn().mockResolvedValue({
        model_id: "gpt-image-2",
        resolution: "2K",
        aspect_ratio: "1:1",
        assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/fallback.png" }],
      }),
    } as unknown as GenerationService;
    const imageResults = new ImageResultStore({
      set: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
    } as unknown as RedisClient, 2_592_000);
    const server = createWjMcpServer({
      config: testConfig(),
      generation,
      imageResults,
      logger: testLogger(),
      widgetHtml: "<!doctype html><p>widget</p>",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A recoverable image" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).not.toHaveProperty("resultId");
    expect(response.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringContaining("https://img.downk.cc/fallback.png"),
    })]);
  });
});

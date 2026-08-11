import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationService } from "../src/generation-service.js";
import { createWjMcpServer, IMAGE_WIDGET_URI, WJ_IMAGE_SERVER_INSTRUCTIONS } from "../src/mcp/server.js";
import { testConfig, testLogger } from "./helpers.js";

describe("WJ MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("advertises and calls image generation and private-attachment editing tools", async () => {
    const generate = vi.fn().mockResolvedValue({
      model_id: "gpt-image-2",
      resolution: "1K",
      aspect_ratio: "1:1",
      duration_ms: 900,
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/generated.png", width: 1024, height: 1024 }],
    });
    const generation = { generate } as unknown as GenerationService;
    const server = createWjMcpServer({ config: testConfig(), generation, logger: testLogger(), widgetHtml: "<!doctype html><p>widget</p>" });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    expect(client.getInstructions()).toBe(WJ_IMAGE_SERVER_INSTRUCTIONS);

    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "generate_image");
    const editTool = tools.tools.find((item) => item.name === "edit_image");
    expect(tool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?._meta?.["openai/outputTemplate"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    expect(tool?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["wj:image"] }]);
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

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "A quiet futuristic city" },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({
      model: "gpt-image-2",
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_link", uri: "https://img.downk.cc/generated.png" }),
    ]));
    expect(generate).toHaveBeenCalledWith("wj-shared-access", expect.objectContaining({
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "1K",
    }));

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
      resolution: "1K",
      reference_image_urls: [
        "https://files.openai.example/target.png?signature=one",
        "https://files.openai.example/reference.png?signature=two",
      ],
    });

    const resource = await client.readResource({ uri: IMAGE_WIDGET_URI });
    expect(resource.contents[0]).toEqual(expect.objectContaining({
      mimeType: "text/html;profile=mcp-app",
      text: "<!doctype html><p>widget</p>",
      _meta: expect.objectContaining({
        ui: expect.objectContaining({
          csp: expect.objectContaining({
            resourceDomains: expect.arrayContaining(["https://img.downk.cc"]),
          }),
        }),
      }),
    }));
  });
});

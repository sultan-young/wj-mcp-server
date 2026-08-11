import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationService } from "../src/generation-service.js";
import { createWjMcpServer, IMAGE_WIDGET_URI } from "../src/mcp/server.js";
import { testConfig, testLogger } from "./helpers.js";

describe("WJ MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("advertises and calls generate_image, with an inline UI fallback", async () => {
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

    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "generate_image");
    expect(tool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));

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

    const resource = await client.readResource({ uri: IMAGE_WIDGET_URI });
    expect(resource.contents[0]).toEqual(expect.objectContaining({
      mimeType: "text/html;profile=mcp-app",
      text: "<!doctype html><p>widget</p>",
    }));
  });
});

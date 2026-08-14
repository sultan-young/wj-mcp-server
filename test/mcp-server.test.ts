import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationService } from "../src/generation-service.js";
import { createWjMcpServer, IMAGE_WIDGET_URI, WJ_IMAGE_SERVER_INSTRUCTIONS } from "../src/mcp/server.js";
import { WjApiError } from "../src/wj/client.js";
import { testConfig, testGenerationService, testLogger, memoryRedis } from "./helpers.js";
import { ImageJobStore } from "../src/image-job-store.js";

function emptyProductDraftClient() {
  return {
    listProductCategories: vi.fn(),
    createProductDraft: vi.fn(),
    updateProductDraft: vi.fn(),
    getProductDraft: vi.fn(),
    listProductDrafts: vi.fn(),
    validateProductDraft: vi.fn(),
  };
}

async function waitForJob(
  client: Client,
  jobId: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const polled = await client.callTool({
      name: "get_image_job_result",
      arguments: { job_id: jobId },
    });
    const content = polled.structuredContent as Record<string, unknown> | undefined;
    if (content && (content.status === "completed" || content.status === "failed" || content.status === "timed_out")) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job ${jobId} did not finish in time`);
}

describe("WJ MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("advertises and calls image generation and private-attachment tools", async () => {
    const generateImage = vi.fn().mockResolvedValue({
      model_id: "gpt-image-2",
      resolution: "2K",
      aspect_ratio: "1:1",
      duration_ms: 900,
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/generated.png", width: 1024, height: 1024 }],
    });
    const redis = memoryRedis();
    const imageJobs = new ImageJobStore(redis, 1_200, 2_592_000);
    const generation = testGenerationService({ generateImage }, {}, imageJobs);
    const calculateProfit = vi.fn().mockResolvedValue({
      formulaVersion: "1.0.0",
      input: { mode: "sellingProfit", country: "US", payment: "US", regulatory: "NONE" },
      results: [{ label: "Profit (CNY)", value: "56.39" }],
      exchangeRates: {
        usdRates: { USD: 1, CNY: 7 },
        cnyRates: { USD: 1 / 7, CNY: 1 },
        updatedAt: "2026-08-11T00:00:00.000Z",
        source: "test",
      },
    });
    const saveProfitCalculation = vi.fn().mockResolvedValue({
      id: "profit-record-1",
      sku: "SKU-001",
      recordName: "US launch 19.99 USD",
      mode: "sellingProfit",
      country: "US",
      estimatedProfitCny: 56.39,
      roasBreakeven: "2.48",
      displaySalePriceUsd: 19.99,
      calculatedResults: { "Profit (CNY)": "56.39" },
    });
    const profitClient = { calculateProfit, saveProfitCalculation };
    const productDraftClient = emptyProductDraftClient();
    const server = createWjMcpServer({
      config: testConfig(),
      generation,
      profitClient,
      productDraftClient,
      logger: testLogger(),
      widgetHtml: "<!doctype html><p>widget</p>",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    expect(client.getInstructions()).toBe(WJ_IMAGE_SERVER_INSTRUCTIONS);
    expect(WJ_IMAGE_SERVER_INSTRUCTIONS).toContain("list_product_categories");
    expect(WJ_IMAGE_SERVER_INSTRUCTIONS).toContain("create_product_draft");

    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "generate_image");
    const imageLookupTool = tools.tools.find((item) => item.name === "get_image_job_result");
    const calculateProfitTool = tools.tools.find((item) => item.name === "calculate_profit");
    const saveProfitTool = tools.tools.find((item) => item.name === "save_profit_calculation");
    const listCategoriesTool = tools.tools.find((item) => item.name === "list_product_categories");
    const createDraftTool = tools.tools.find((item) => item.name === "create_product_draft");
    expect(tools.tools.map((item) => item.name)).not.toContain("generate_images");
    expect(tools.tools.map((item) => item.name)).not.toContain("edit_image");
    expect(tools.tools.map((item) => item.name)).not.toContain("publish_product_draft");
    expect(tools.tools.map((item) => item.name)).not.toContain("get_image");
    expect(tools.tools.map((item) => item.name)).not.toContain("get_image_job");
    expect(tools.tools.map((item) => item.name)).not.toContain("get_image_result");
    expect(listCategoriesTool).toBeTruthy();
    expect(createDraftTool?.description).toContain("user_confirmed");
    expect(tool?._meta?.["ui/resourceUri"]).toBe(IMAGE_WIDGET_URI);
    expect(tool?._meta?.["openai/outputTemplate"]).toBe(IMAGE_WIDGET_URI);
    expect(imageLookupTool?._meta?.ui).toEqual(expect.objectContaining({ visibility: ["app"] }));
    expect(imageLookupTool?._meta?.["openai/widgetAccessible"]).toBe(true);
    expect(imageLookupTool?._meta?.["ui/resourceUri"]).toBeUndefined();
    expect(imageLookupTool?._meta?.["openai/outputTemplate"]).toBeUndefined();
    expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    expect(tool?.inputSchema.properties).not.toHaveProperty("count");
    expect(tool?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["wj:tools"] }]);
    expect(tool?._meta?.["openai/fileParams"]).toEqual(["gpt_reference_images"]);
    expect(tool?.description).toContain("jobId immediately");
    expect(tool?.description).toContain("prompts");
    expect(tool?.inputSchema).toEqual(expect.objectContaining({
      type: "object",
      required: expect.arrayContaining(["prompts"]),
      properties: expect.objectContaining({
        prompts: expect.objectContaining({ type: "array" }),
        gpt_reference_images: expect.objectContaining({ type: "array" }),
      }),
    }));
    expect(tool?.inputSchema.properties).not.toHaveProperty("prompt");
    expect(tool?.inputSchema.properties).not.toHaveProperty("reference_image_urls");
    const generateProperties = tool?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
    const referenceImagesSchema = generateProperties?.gpt_reference_images;
    expect(referenceImagesSchema?.items).toEqual(expect.objectContaining({
      additionalProperties: false,
      required: ["download_url", "file_id"],
      properties: expect.objectContaining({
        download_url: expect.objectContaining({ type: "string" }),
        file_id: expect.objectContaining({ type: "string" }),
      }),
    }));
    expect(calculateProfitTool).toBeTruthy();
    expect(saveProfitTool).toBeTruthy();

    const profitResponse = await client.callTool({
      name: "calculate_profit",
      arguments: { country: "US", cost: 35, shipping: 28, selling_price: 19.99 },
    });
    expect(profitResponse.isError).not.toBe(true);
    expect(calculateProfit).toHaveBeenCalledWith(expect.objectContaining({
      country: "US",
      packaging: 2,
      selling_price: 19.99,
    }));

    await client.callTool({
      name: "save_profit_calculation",
      arguments: {
        country: "US",
        cost: 35,
        shipping: 28,
        selling_price: 19.99,
        sku: "SKU-001",
        record_name: "US launch 19.99 USD",
      },
    });
    expect(saveProfitCalculation).toHaveBeenCalledWith(expect.objectContaining({
      sku: "SKU-001",
      record_name: "US launch 19.99 USD",
    }));

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompts: ["A quiet futuristic city"] },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(expect.objectContaining({
      jobId: expect.stringMatching(/^wj_job_/),
      status: expect.stringMatching(/^(queued|running)$/),
      model: "gpt-image-2",
      assets: [],
      progress: expect.objectContaining({
        total: 1,
        succeeded: 0,
        failed: 0,
        pending: 1,
      }),
    }));
    const acceptedJobId = (response.structuredContent as { jobId: string }).jobId;
    const completed = await waitForJob(client, acceptedJobId);
    expect(completed).toEqual(expect.objectContaining({
      status: "completed",
      jobId: acceptedJobId,
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
      progress: expect.objectContaining({
        total: 1,
        succeeded: 1,
        failed: 0,
        pending: 0,
      }),
    }));
    expect(completed).not.toHaveProperty("resultId");
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "A quiet futuristic city",
      model: "gpt-image-2",
      aspect_ratio: "1:1",
      resolution: "2K",
    }));

    const generateCallsBeforeRecovery = generateImage.mock.calls.length;
    const recoveredResponse = await client.callTool({
      name: "get_image_job_result",
      arguments: { job_id: acceptedJobId },
    });
    expect(recoveredResponse.isError).not.toBe(true);
    expect(recoveredResponse.structuredContent).toEqual(expect.objectContaining({
      status: "completed",
      jobId: acceptedJobId,
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(generateImage).toHaveBeenCalledTimes(generateCallsBeforeRecovery);

    const res1k = await client.callTool({
      name: "generate_image",
      arguments: { prompts: ["A small explicit-resolution image"], resolution: "1K" },
    });
    const job1k = (res1k.structuredContent as { jobId: string }).jobId;
    await waitForJob(client, job1k);
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      resolution: "1K",
    }));

    const editLikeResponse = await client.callTool({
      name: "generate_image",
      arguments: {
        prompts: ["Add the handwritten name from image two to the board in image one"],
        gpt_reference_images: [
          {
            download_url: "https://files.openai.example/target.png?signature=one",
            file_id: "file_target",
            mime_type: "image/png",
            file_name: "target.png",
          },
          {
            download_url: "https://files.openai.example/reference.png?signature=two",
            file_id: "file_reference",
            mime_type: "image/png",
            file_name: "reference.png",
          },
        ],
      },
    });
    expect(editLikeResponse.isError).not.toBe(true);
    const editJobId = (editLikeResponse.structuredContent as { jobId: string }).jobId;
    const editCompleted = await waitForJob(client, editJobId);
    expect(editCompleted).toEqual(expect.objectContaining({
      status: "completed",
      assets: [expect.objectContaining({ url: "https://img.downk.cc/generated.png" })],
    }));
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Add the handwritten name from image two to the board in image one",
      model: "gpt-image-2",
      gpt_reference_images: [
        expect.objectContaining({ file_id: "file_target" }),
        expect.objectContaining({ file_id: "file_reference" }),
      ],
    }));

    const batchResponse = await client.callTool({
      name: "generate_image",
      arguments: {
        prompts: ["red mug on white table", "blue mug on white table", "green mug on white table"],
      },
    });
    expect(batchResponse.isError).not.toBe(true);
    const batchJobId = (batchResponse.structuredContent as { jobId: string }).jobId;
    await waitForJob(client, batchJobId);
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "red mug on white table",
    }));

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
        "openai/widgetCSP": expect.objectContaining({
          resource_domains: expect.arrayContaining(["https://img.downk.cc"]),
          connect_domains: expect.arrayContaining(["https://img.downk.cc"]),
          redirect_domains: expect.arrayContaining(["https://img.downk.cc"]),
        }),
        "openai/widgetDescription": expect.stringContaining("WJ-generated images"),
      }),
    }));
  });

  it("surfaces WJ authorization failures on the job poll path", async () => {
    const generateImage = vi.fn().mockRejectedValue(new WjApiError("authorization policy denied the request", 403));
    const generation = testGenerationService({ generateImage });
    const server = createWjMcpServer({
      config: testConfig(),
      generation,
      profitClient: { calculateProfit: vi.fn(), saveProfitCalculation: vi.fn() },
      productDraftClient: emptyProductDraftClient(),
      logger: testLogger(),
      widgetHtml: "<!doctype html><p>widget</p>",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompts: ["A test image"] },
    });
    expect(response.isError).not.toBe(true);
    const jobId = (response.structuredContent as { jobId: string }).jobId;
    const failed = await waitForJob(client, jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("HTTP 403");
  });

  it("lists categories and creates a confirmed product draft", async () => {
    const generation = { submit: vi.fn(), getImage: vi.fn(), generate: vi.fn() } as unknown as GenerationService;
    const listProductCategories = vi.fn().mockResolvedValue([
      { value: "BP", label: "标品", describe: "无定制工厂货" },
      { value: "SK", label: "骷髅", describe: "骷髅系列" },
    ]);
    const createProductDraft = vi.fn().mockResolvedValue({
      id: "draft-1",
      sku: "BP-G1001",
      reservedSku: "BP-G1001",
      category: "BP",
      isGroup: true,
      publishStatus: "draft",
      isDraft: true,
      reservedChildSkus: ["BP-G1001-R", "BP-G1001-G"],
    });
    const productDraftClient = {
      ...emptyProductDraftClient(),
      listProductCategories,
      createProductDraft,
    };
    const server = createWjMcpServer({
      config: testConfig(),
      generation,
      profitClient: { calculateProfit: vi.fn(), saveProfitCalculation: vi.fn() },
      productDraftClient,
      logger: testLogger(),
      widgetHtml: "<!doctype html><p>widget</p>",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    const categoriesResponse = await client.callTool({ name: "list_product_categories", arguments: {} });
    expect(categoriesResponse.isError).not.toBe(true);
    expect(categoriesResponse.structuredContent).toEqual({
      categories: [
        { value: "BP", label: "标品", describe: "无定制工厂货" },
        { value: "SK", label: "骷髅", describe: "骷髅系列" },
      ],
    });

    const rejected = await client.callTool({
      name: "create_product_draft",
      arguments: { category: "BP", isGroup: true },
    });
    expect(rejected.isError).toBe(true);
    expect(createProductDraft).not.toHaveBeenCalled();

    const created = await client.callTool({
      name: "create_product_draft",
      arguments: {
        category: "BP",
        isGroup: true,
        user_confirmed: true,
        children: [
          { variantSerial: "R", stock: 0 },
          { variantSerial: "G", stock: 0 },
        ],
      },
    });
    expect(created.isError).not.toBe(true);
    expect(createProductDraft).toHaveBeenCalledWith(expect.objectContaining({
      category: "BP",
      isGroup: true,
      user_confirmed: true,
    }));
    expect(created.content).toEqual([expect.objectContaining({
      type: "text",
      text: expect.stringContaining("BP-G1001"),
    })]);
  });

  it("keeps completed jobs lookupable by the same job_id", async () => {
    const redis = memoryRedis();
    const imageJobs = new ImageJobStore(redis, 1_200, 2_592_000);
    const generateImage = vi.fn().mockResolvedValue({
      model_id: "gpt-image-2",
      resolution: "2K",
      aspect_ratio: "1:1",
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/fallback.png" }],
    });
    const generation = testGenerationService({ generateImage }, {}, imageJobs);
    const server = createWjMcpServer({
      config: testConfig(),
      generation,
      profitClient: { calculateProfit: vi.fn(), saveProfitCalculation: vi.fn() },
      productDraftClient: emptyProductDraftClient(),
      logger: testLogger(),
      widgetHtml: "<!doctype html><p>widget</p>",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => { await client.close(); await server.close(); });

    const response = await client.callTool({
      name: "generate_image",
      arguments: { prompts: ["A recoverable image"] },
    });
    expect(response.isError).not.toBe(true);
    const jobId = (response.structuredContent as { jobId: string }).jobId;
    const completed = await waitForJob(client, jobId);
    expect(completed.status).toBe("completed");
    expect(completed).not.toHaveProperty("resultId");
    expect(completed.assets).toEqual([
      expect.objectContaining({ url: "https://img.downk.cc/fallback.png" }),
    ]);

    const recovered = await client.callTool({
      name: "get_image_job_result",
      arguments: { job_id: jobId },
    });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toEqual(expect.objectContaining({
      jobId,
      status: "completed",
      assets: [expect.objectContaining({ url: "https://img.downk.cc/fallback.png" })],
    }));
  });
});

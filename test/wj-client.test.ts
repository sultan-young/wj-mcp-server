import { describe, expect, it, vi } from "vitest";

import { APP_VERSION } from "../src/version.js";
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
    expect(new Headers(init?.headers).get("user-agent")).toBe(`wj-mcp-server/${APP_VERSION}`);
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
      gpt_reference_images: [
        {
          download_url: "https://files.openai.example/target.png?signature=one",
          file_id: "file_target",
        },
        {
          download_url: "https://files.openai.example/reference.png?signature=two",
          file_id: "file_reference",
        },
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

  it("calculates profit through the WJ server with country defaults handled upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        formulaVersion: "1.0.0",
        input: { mode: "sellingProfit", country: "US", payment: "US", regulatory: "NONE" },
        results: [{ label: "Profit (CNY)", value: "56.39" }],
        exchangeRates: {
          usdRates: { USD: 1, CNY: 7 },
          cnyRates: { USD: 1 / 7, CNY: 1 },
          updatedAt: "2026-08-11T00:00:00.000Z",
          source: "test",
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    const result = await client.calculateProfit({
      mode: "sellingProfit",
      country: "US",
      cost: 35,
      shipping: 28,
      packaging: 2,
      labor: 0,
      refund_loss_rate: 1.5,
      ad_rate: 0,
      selling_price: 19.99,
      shipping_income: 0,
      gift_wrap_income: 0,
      price_currency: "USD",
      discount: 0,
    });

    expect(result.results[0]?.value).toBe("56.39");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://wj.example.com/api/v1/commonTools/profitCalculator/calculate");
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      country: "US",
      sellingPrice: 19.99,
      refundLossRate: 1.5,
    }));
  });

  it("records profit with a required SKU and generated record name", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        id: "record-1",
        sku: "SKU-001",
        recordName: "US launch 19.99 USD",
        mode: "sellingProfit",
        country: "US",
        estimatedProfitCny: 56.39,
        roasBreakeven: "2.48",
        displaySalePriceUsd: 19.99,
        calculatedResults: { "Profit (CNY)": "56.39" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    await client.saveProfitCalculation({
      sku: "SKU-001",
      record_name: "US launch 19.99 USD",
      mode: "sellingProfit",
      country: "US",
      cost: 35,
      shipping: 28,
      packaging: 2,
      labor: 0,
      refund_loss_rate: 1.5,
      ad_rate: 0,
      selling_price: 19.99,
      shipping_income: 0,
      gift_wrap_income: 0,
      price_currency: "USD",
      discount: 0,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://wj.example.com/api/v1/commonTools/profitCalculator/sku/upsert");
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      sku: "SKU-001",
      recordName: "US launch 19.99 USD",
    }));
  });

  it("lists product categories and creates a draft without sending user_confirmed upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{ value: "BP", label: "标品", describe: "工厂货" }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { id: "d1", sku: "BP-10001", reservedSku: "BP-10001", category: "BP", publishStatus: "draft", isDraft: true },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new WjClient(testConfig(), testLogger(), fetchMock);

    const categories = await client.listProductCategories();
    expect(categories).toEqual([{ value: "BP", label: "标品", describe: "工厂货" }]);

    await client.createProductDraft({
      category: "BP",
      user_confirmed: true,
      nameCn: "测试",
    });

    const [createUrl, createInit] = fetchMock.mock.calls[1] ?? [];
    expect(String(createUrl)).toBe("https://wj.example.com/api/v1/products/drafts/create");
    expect(JSON.parse(String(createInit?.body))).toEqual({
      category: "BP",
      nameCn: "测试",
    });
  });
});

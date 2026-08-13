import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { APP_VERSION } from "../version.js";
import {
  type CalculateProfitToolInput,
  type ProfitCalculationData,
  profitCalculationDataSchema,
  type SavedProfitRecord,
  savedProfitRecordSchema,
  type SaveProfitToolInput,
  toProfitApiInput,
} from "./profit-types.js";
import {
  type CreateProductDraftInput,
  type GetProductDraftInput,
  type ListProductDraftsInput,
  listProductDraftsResultSchema,
  type ProductCategory,
  type ProductDraft,
  productCategorySchema,
  productDraftSchema,
  toCreateDraftApiBody,
  toListDraftsApiBody,
  toUpdateDraftApiBody,
  type UpdateProductDraftInput,
  type ValidateProductDraftInput,
  validateProductDraftResultSchema,
} from "./product-draft-types.js";
import { type GenerateImageInput, type WjImageData, wjImageResponseSchema } from "./types.js";
import { z } from "zod";

export class WjApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WjApiError";
  }
}

export class WjClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generateImage(input: GenerateImageInput): Promise<WjImageData> {
    if (!this.config.WJ_ALLOWED_MODELS.includes(input.model)) {
      throw new WjApiError(`Model ${input.model} is not allowed`);
    }

    const endpoint = new URL(this.config.WJ_IMAGE_PATH, this.config.wjApiBaseUrl);
    const requestBody = {
      model: input.model,
      prompt: input.prompt,
      ...(input.reference_image_urls?.length ? { input_images: input.reference_image_urls } : {}),
      output: {
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
      },
      response_format: "url",
    };

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.WJ_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `wj-mcp-server/${APP_VERSION}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.WJ_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new WjApiError(isTimeout ? "WJ image generation timed out" : "Unable to reach the WJ image service");
    }

    const rawBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WjApiError("WJ returned a non-JSON response", response.status);
    }

    if (!response.ok) {
      const upstreamMessage = extractUpstreamMessage(json);
      this.logger.warn({ status: response.status, durationMs: Date.now() - startedAt }, "WJ image request failed");
      throw new WjApiError(upstreamMessage ?? `WJ request failed with HTTP ${response.status}`, response.status);
    }

    const parsed = wjImageResponseSchema.safeParse(json);
    if (!parsed.success || parsed.data.success === false) {
      this.logger.warn({ status: response.status, durationMs: Date.now() - startedAt }, "Invalid WJ image response");
      throw new WjApiError(parsed.success ? parsed.data.message ?? "WJ reported generation failure" : "WJ returned an invalid image response", response.status);
    }

    for (const asset of parsed.data.data.assets) {
      if (this.config.NODE_ENV === "production" && new URL(asset.url).protocol !== "https:") {
        throw new WjApiError("WJ returned an insecure image URL", response.status);
      }
    }

    this.logger.info(
      {
        model: parsed.data.data.model_id,
        assetCount: parsed.data.data.assets.length,
        durationMs: Date.now() - startedAt,
      },
      "WJ image generated",
    );
    return parsed.data.data;
  }

  async calculateProfit(input: CalculateProfitToolInput): Promise<ProfitCalculationData> {
    return await this.postWjData(
      "/api/v1/commonTools/profitCalculator/calculate",
      toProfitApiInput(input),
      profitCalculationDataSchema,
      "profit calculation",
    );
  }

  async saveProfitCalculation(input: SaveProfitToolInput): Promise<SavedProfitRecord> {
    return await this.postWjData(
      "/api/v1/commonTools/profitCalculator/sku/upsert",
      toProfitApiInput(input),
      savedProfitRecordSchema,
      "profit calculation recording",
    );
  }

  async listProductCategories(): Promise<ProductCategory[]> {
    const rows = await this.postWjData(
      "/api/v1/products/category/list",
      {},
      z.array(productCategorySchema),
      "product category list",
    );
    return rows.map((row) => ({
      id: row.id,
      value: String(row.value || "").trim(),
      label: String(row.label || "").trim(),
      describe: String(row.describe || "").trim(),
    })).filter((row) => row.value);
  }

  async createProductDraft(input: CreateProductDraftInput): Promise<ProductDraft> {
    return await this.postWjData(
      "/api/v1/products/drafts/create",
      toCreateDraftApiBody(input),
      productDraftSchema,
      "product draft create",
    );
  }

  async updateProductDraft(input: UpdateProductDraftInput): Promise<ProductDraft> {
    return await this.postWjData(
      "/api/v1/products/drafts/update",
      toUpdateDraftApiBody(input),
      productDraftSchema,
      "product draft update",
    );
  }

  async getProductDraft(input: GetProductDraftInput): Promise<ProductDraft> {
    return await this.postWjData(
      "/api/v1/products/drafts/get",
      { id: input.id },
      productDraftSchema,
      "product draft get",
    );
  }

  async listProductDrafts(input: ListProductDraftsInput) {
    const body = toListDraftsApiBody(input);
    const endpoint = new URL("/api/v1/products/drafts/list", this.config.wjApiBaseUrl);
    const json = await this.postWjRaw(endpoint, body, "product draft list");
    const envelope = z.object({
      success: z.boolean(),
      message: z.string().optional(),
      data: z.array(productDraftSchema).optional(),
      pagination: z.object({
        pageNo: z.number().optional(),
        pageSize: z.number().optional(),
        total: z.number().optional(),
      }).passthrough().optional(),
    }).safeParse(json);
    if (!envelope.success || !envelope.data.success || !envelope.data.data) {
      throw new WjApiError(
        envelope.success ? envelope.data.message ?? "WJ reported product draft list failure" : "WJ returned an invalid product draft list response",
      );
    }
    return listProductDraftsResultSchema.parse({
      list: envelope.data.data,
      pagination: envelope.data.pagination,
    });
  }

  async validateProductDraft(input: ValidateProductDraftInput) {
    return await this.postWjData(
      "/api/v1/products/drafts/validate",
      { id: input.id },
      validateProductDraftResultSchema,
      "product draft validate",
    );
  }

  private async postWjData<T>(path: string, body: unknown, dataSchema: z.ZodType<T>, operation: string): Promise<T> {
    const endpoint = new URL(path, this.config.wjApiBaseUrl);
    const json = await this.postWjRaw(endpoint, body, operation);
    const envelope = z.object({
      success: z.boolean(),
      message: z.string().optional(),
      data: dataSchema.optional(),
    }).safeParse(json);
    if (!envelope.success) {
      throw new WjApiError(`WJ returned an invalid ${operation} response`);
    }
    if (!envelope.data.success) {
      throw new WjApiError(envelope.data.message ?? `WJ reported ${operation} failure`);
    }
    if (envelope.data.data === undefined) {
      throw new WjApiError(`WJ returned an invalid ${operation} response`);
    }
    return envelope.data.data;
  }

  private async postWjRaw(endpoint: URL, body: unknown, operation: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.WJ_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `wj-mcp-server/${APP_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.WJ_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new WjApiError(isTimeout ? `WJ ${operation} timed out` : `Unable to reach WJ for ${operation}`);
    }

    const rawBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WjApiError(`WJ returned a non-JSON response for ${operation}`, response.status);
    }

    if (!response.ok) {
      throw new WjApiError(extractUpstreamMessage(json) ?? `WJ ${operation} failed with HTTP ${response.status}`, response.status);
    }
    return json;
  }
}

function extractUpstreamMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.length <= 500) return value;
  }
  return undefined;
}

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WJ_MCP_SCOPE } from "../auth/provider.js";
import type { AppConfig } from "../config.js";
import type { GenerationService } from "../generation-service.js";
import { imageJobStatusSchema, imagePromptFailureSchema, type ImageJobView } from "../image-job-store.js";
import { type ImageResultData, ImageResultStore, type PersistedImageResult } from "../image-result-store.js";
import { UsageLimitError } from "../limits.js";
import type { AppLogger } from "../logger.js";
import { APP_VERSION } from "../version.js";
import { WjApiError, type WjClient } from "../wj/client.js";
import {
  calculateProfitToolInputSchema,
  profitCalculationDataSchema,
  savedProfitRecordSchema,
  saveProfitToolInputSchema,
} from "../wj/profit-types.js";
import {
  createProductDraftInputSchema,
  getProductDraftInputSchema,
  listProductCategoriesInputSchema,
  listProductDraftsInputSchema,
  productCategorySchema,
  productDraftSchema,
  updateProductDraftInputSchema,
  validateProductDraftInputSchema,
  validateProductDraftResultSchema,
} from "../wj/product-draft-types.js";
import {
  aspectRatioSchema,
  generateImageInputSchema,
  imageAssetSchema,
  resolutionSchema,
} from "../wj/types.js";

export const IMAGE_WIDGET_URI = "ui://wj/image-result.html";
export const WJ_IMAGE_SERVER_INSTRUCTIONS = `Use generate_image immediately when the user explicitly asks to use WJ, WJ image generation/editing, or 无界生图. Always pass prompts as a string array (1–10 entries); a single image uses a one-element array. gpt_reference_images are shared by every prompt in the same call. When every output shares the same references, use one generate_image with multiple prompts. When outputs need different reference subsets, issue one generate_image per subset and dispatch those independent calls concurrently in the same tool-call turn—never wait for one to finish before starting the next. Preserve attachment order; when editing, put the image being changed first in gpt_reference_images, then other references, and describe the change in each prompts entry. generate_image returns a jobId immediately; the WJ image component polls until completion (up to 20 minutes). Do not claim images are ready until the component shows them or a completed result includes assets. Never paste markdown image embeds (![](url))—that duplicates the component when it is visible. Do not call get_image_result while the generate_image component is still loading or already showing images. If the component fails to load ("Failed to fetch template") or is missing: call get_image_result with the job_id (and wait_ms) until completed, then paste plain-text HTTPS links if needed. Prefer result_id with get_image_result when available. Never regenerate solely because the component failed. Mention Job ID / Result ID when useful for recovery. If native ChatGPT image generation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call WJ once without asking again. Default to gpt-image-2, 2K, and 1:1 unless specified otherwise. Do not claim success unless assets are available.

For profit calculations, call calculate_profit first and clearly explain that the result has not been saved. Never save merely because the user asked for a calculation. Only call save_profit_calculation after the user explicitly confirms that the displayed calculation should be recorded. Recording requires an existing product SKU: if the user has not supplied one, ask for it and never invent it. Use a user-provided calculation name when available; otherwise generate a concise recognizable record_name from the country, product context, and price before saving.

For product drafts: always call list_product_categories first and choose category by matching label/describe from the live list—never invent a category prefix from memory. Decide single product vs product group from the user's variant needs. Present the planned category, isGroup, and variantSerials, then wait for explicit user confirmation before create_product_draft (SKU reservation is irreversible; user_confirmed must be true). Do not publish or finalize products via MCP; the user creates products manually in ERP/Etsy. Quantity uses display form SKU * N; packaging/morph notes use parentheses in communication and the notes field in drafts—never encode *N or (note) into Product.sku.`;

const oauthSecuritySchemes = [{ type: "oauth2" as const, scopes: [WJ_MCP_SCOPE] }];

function imageToolMeta(extra: Record<string, unknown> = {}) {
  return {
    securitySchemes: oauthSecuritySchemes,
    ui: { resourceUri: IMAGE_WIDGET_URI },
    "openai/outputTemplate": IMAGE_WIDGET_URI,
    ...extra,
  };
}

function toolSecurityMeta(extra: Record<string, unknown> = {}) {
  return {
    securitySchemes: oauthSecuritySchemes,
    ...extra,
  };
}

function widgetResourceMeta(config: AppConfig) {
  const resourceDomains = config.imageResourceDomains;
  return {
    ui: {
      prefersBorder: false,
      domain: config.publicBaseUrl.origin,
      csp: {
        resourceDomains,
        connectDomains: resourceDomains,
      },
    },
    "openai/widgetDescription": "Displays WJ-generated images inline with an open-original action and original HTTPS links.",
    "openai/widgetDomain": config.publicBaseUrl.origin,
    "openai/widgetCSP": {
      resource_domains: resourceDomains,
      connect_domains: resourceDomains,
      redirect_domains: resourceDomains,
    },
  };
}

const persistenceOutputSchema = {
  resultId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
};

const imageOutputSchema = {
  model: z.string(),
  resolution: resolutionSchema.or(z.string()),
  aspectRatio: aspectRatioSchema.or(z.string()),
  durationMs: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema),
  jobId: z.string().optional(),
  status: imageJobStatusSchema.optional(),
  error: z.string().optional(),
  ...persistenceOutputSchema,
};

const imageJobOutputSchema = {
  jobId: z.string(),
  status: imageJobStatusSchema,
  model: z.string(),
  resolution: z.string(),
  aspectRatio: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema),
  failures: z.array(imagePromptFailureSchema).optional(),
  resultId: z.string().optional(),
  resultCreatedAt: z.string().datetime().optional(),
  resultExpiresAt: z.string().datetime().optional(),
};

type McpServerDependencies = {
  config: AppConfig;
  generation: GenerationService;
  imageResults: ImageResultStore;
  profitClient: Pick<WjClient, "calculateProfit" | "saveProfitCalculation">;
  productDraftClient: Pick<
    WjClient,
    | "listProductCategories"
    | "createProductDraft"
    | "updateProductDraft"
    | "getProductDraft"
    | "listProductDrafts"
    | "validateProductDraft"
  >;
  logger: AppLogger;
  widgetHtml: string;
};

export function createWjMcpServer(dependencies: McpServerDependencies): McpServer {
  const { config, generation, imageResults, profitClient, productDraftClient, logger, widgetHtml } = dependencies;
  const server = new McpServer(
    { name: "wj-mcp-server", version: APP_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: WJ_IMAGE_SERVER_INSTRUCTIONS,
    },
  );

  registerAppTool(
    server,
    "generate_image",
    {
      title: "使用 WJ 生成图片",
      description:
        "Submit WJ image generation/editing and return a jobId immediately. Always pass prompts as a string array (1–10); one image uses [\"...\"]. The server runs jobs in the background with shared model/aspect_ratio/resolution. Optional gpt_reference_images (file params, up to 10) are shared across every prompt in the call. Default to gpt-image-2 and 2K. The WJ image component polls until completion (up to 20 minutes). Do not claim images are ready until the component shows assets. Never use markdown image embeds. Each generated image consumes WJ quota.",
      inputSchema: generateImageInputSchema,
      outputSchema: imageJobOutputSchema,
      annotations: {
        title: "使用 WJ 生成图片",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: imageToolMeta({
        "openai/fileParams": ["gpt_reference_images"],
        "openai/toolInvocation/invoking": "WJ 正在提交生图任务",
        "openai/toolInvocation/invoked": "WJ 生图任务已提交",
      }),
    },
    async (rawInput, extra) => {
      try {
        const input = generateImageInputSchema.parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const terminalId = String(extra.authInfo?.extra?.terminalId ?? extra.authInfo?.clientId ?? subject);
        const job = await generation.submit(subject, terminalId, input);
        return buildImageJobToolResult(job, "accepted");
      } catch (error) {
        const message = toSafeToolError(error);
        logger.warn({ err: error, tool: "generate_image" }, "MCP image tool failed");
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  registerAppTool(
    server,
    "get_image_job",
    {
      title: "查询 WJ 生图任务",
      description:
        "Poll a WJ image job by jobId. Used by the WJ image component. Returns current status; when wait_ms is set, long-polls up to that budget before responding.",
      inputSchema: {
        job_id: z.string().min(1).describe("The jobId returned by generate_image."),
        wait_ms: z.number().int().min(0).max(45_000).optional()
          .describe("Optional long-poll budget in milliseconds (0–45000)."),
      },
      outputSchema: imageJobOutputSchema,
      annotations: {
        title: "查询 WJ 生图任务",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: toolSecurityMeta({
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
      }),
    },
    async (rawInput, extra) => {
      try {
        const input = z.object({
          job_id: z.string().min(1),
          wait_ms: z.number().int().min(0).max(45_000).optional(),
        }).parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const job = await generation.pollJob(subject, input.job_id, input.wait_ms ?? 45_000);
        if (!job) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: "WJ image job was not found, has expired, or belongs to another user.",
            }],
          };
        }
        return buildImageJobToolResult(job, "polled");
      } catch (error) {
        const message = toSafeToolError(error);
        logger.warn({ err: error, tool: "get_image_job" }, "MCP image job poll failed");
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  registerAppTool(
    server,
    "calculate_profit",
    {
      title: "Calculate WJ profit",
      description:
        "Calculate product profit or reverse-calculate a required selling price using WJ server rules and current exchange rates. This tool never saves a record. Use it first, present the result, and ask whether the user wants to record it.",
      inputSchema: calculateProfitToolInputSchema,
      outputSchema: profitCalculationDataSchema.shape,
      annotations: {
        title: "Calculate WJ profit",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is calculating profit",
        "openai/toolInvocation/invoked": "WJ profit calculation completed",
      }),
    },
    async (rawInput) => {
      try {
        const input = calculateProfitToolInputSchema.parse(rawInput);
        const result = await profitClient.calculateProfit(input);
        return {
          structuredContent: result,
          content: [{
            type: "text" as const,
            text: [
              "WJ profit calculation completed. This result has not been saved.",
              ...result.results.map((item) => `${item.label}: ${item.value}${item.subValue ? ` ${item.subValue}` : ""}`),
              `Exchange-rate source: ${result.exchangeRates.source}; updated at ${result.exchangeRates.updatedAt}.`,
              "Explain the result, then ask whether the user wants to record it. Do not save without explicit confirmation.",
            ].join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "calculate_profit" }, "MCP profit calculation failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "save_profit_calculation",
    {
      title: "Record WJ profit calculation",
      description:
        "Record a profit calculation only after the user explicitly confirms. Requires a real existing SKU and a recognizable record name. Never invent a SKU. WJ recalculates on the server before saving, and the same SKU updates its existing record.",
      inputSchema: saveProfitToolInputSchema,
      outputSchema: savedProfitRecordSchema.shape,
      annotations: {
        title: "Record WJ profit calculation",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is recording the profit calculation",
        "openai/toolInvocation/invoked": "WJ profit calculation recorded",
      }),
    },
    async (rawInput) => {
      try {
        const input = saveProfitToolInputSchema.parse(rawInput);
        const saved = await profitClient.saveProfitCalculation(input);
        const structuredContent = {
          id: saved.id,
          sku: saved.sku,
          recordName: saved.recordName,
          mode: saved.mode,
          country: saved.country,
          estimatedProfitCny: saved.estimatedProfitCny,
          roasBreakeven: saved.roasBreakeven,
          displaySalePriceUsd: saved.displaySalePriceUsd,
          calculatedResults: saved.calculatedResults,
        };
        return {
          structuredContent,
          content: [{
            type: "text" as const,
            text: [
              `Profit calculation recorded successfully for SKU ${saved.sku}.`,
              `Record name: ${saved.recordName || input.record_name}.`,
              `Estimated profit (CNY): ${saved.estimatedProfitCny}.`,
              `Break-even ROAS: ${saved.roasBreakeven}.`,
            ].join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "save_profit_calculation" }, "MCP profit recording failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "list_product_categories",
    {
      title: "List WJ product categories",
      description:
        "List live product categories (value/label/describe). Always call this before choosing a draft category. Match by label and describe; never invent a category code.",
      inputSchema: listProductCategoriesInputSchema,
      outputSchema: {
        categories: z.array(productCategorySchema),
      },
      annotations: {
        title: "List WJ product categories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is listing product categories",
        "openai/toolInvocation/invoked": "WJ product categories listed",
      }),
    },
    async () => {
      try {
        const categories = await productDraftClient.listProductCategories();
        return {
          structuredContent: { categories },
          content: [{
            type: "text" as const,
            text: [
              `Found ${categories.length} product categories. Choose by label/describe, then use value as category.`,
              ...categories.map((item) => `- ${item.value}: ${item.label}${item.describe ? ` — ${item.describe}` : ""}`),
            ].join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "list_product_categories" }, "MCP product category list failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "create_product_draft",
    {
      title: "Create WJ product draft",
      description:
        "Create a product draft and immediately reserve a SKU. Requires user_confirmed=true after the user explicitly approves the planned category, single-vs-group choice, and variantSerials. Never invent category codes or main serial numbers. Does not publish; ERP/Etsy finalization is manual.",
      inputSchema: createProductDraftInputSchema,
      outputSchema: productDraftSchema.shape,
      annotations: {
        title: "Create WJ product draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is creating a product draft",
        "openai/toolInvocation/invoked": "WJ product draft created",
      }),
    },
    async (rawInput) => {
      try {
        const input = createProductDraftInputSchema.parse(rawInput);
        const draft = await productDraftClient.createProductDraft(input);
        const sku = draft.reservedSku || draft.sku || "";
        return {
          structuredContent: draft,
          content: [{
            type: "text" as const,
            text: [
              `Product draft created. Reserved SKU: ${sku || "(unknown)"}.`,
              draft.isGroup ? `Group draft. Child SKUs: ${(draft.reservedChildSkus || []).join(", ") || "(none yet)"}.` : "Single-product draft.",
              "This SKU is reserved for procurement. It is still a draft — do not claim it is published. The user must create the product manually in ERP/Etsy.",
              "You may update_product_draft to fill images and fields. Use validate_product_draft to check missing fields.",
            ].join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "create_product_draft" }, "MCP product draft create failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "update_product_draft",
    {
      title: "Update WJ product draft",
      description:
        "Update an existing product draft (images, names, children/variantSerial, prices, notes, etc.). Changing category or isGroup re-reserves SKU and voids the old one — requires user_confirmed=true. When sending children, include the full list; omitted variantSerials are discarded.",
      inputSchema: updateProductDraftInputSchema,
      outputSchema: productDraftSchema.shape,
      annotations: {
        title: "Update WJ product draft",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is updating a product draft",
        "openai/toolInvocation/invoked": "WJ product draft updated",
      }),
    },
    async (rawInput) => {
      try {
        const input = updateProductDraftInputSchema.parse(rawInput);
        const draft = await productDraftClient.updateProductDraft(input);
        const sku = draft.reservedSku || draft.sku || "";
        return {
          structuredContent: draft,
          content: [{
            type: "text" as const,
            text: [
              `Product draft updated. Current reserved SKU: ${sku || "(unknown)"}.`,
              draft.skuReallocated && draft.previousReservedSku
                ? `WARNING: SKU reallocated. Old ${draft.previousReservedSku} is voided and not recycled. ${draft.warning || ""}`
                : "",
              draft.isGroup && draft.reservedChildSkus?.length
                ? `Child SKUs: ${draft.reservedChildSkus.join(", ")}`
                : "",
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "update_product_draft" }, "MCP product draft update failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "get_product_draft",
    {
      title: "Get WJ product draft",
      description: "Fetch one product draft by id.",
      inputSchema: getProductDraftInputSchema,
      outputSchema: productDraftSchema.shape,
      annotations: {
        title: "Get WJ product draft",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is loading a product draft",
        "openai/toolInvocation/invoked": "WJ product draft loaded",
      }),
    },
    async (rawInput) => {
      try {
        const input = getProductDraftInputSchema.parse(rawInput);
        const draft = await productDraftClient.getProductDraft(input);
        return {
          structuredContent: draft,
          content: [{
            type: "text" as const,
            text: `Draft ${draft.id}: SKU ${draft.reservedSku || draft.sku || "?"}, category ${draft.category || "?"}, isGroup=${Boolean(draft.isGroup)}.`,
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "get_product_draft" }, "MCP product draft get failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "list_product_drafts",
    {
      title: "List WJ product drafts",
      description: "List product drafts with optional category/sku/keyword filters.",
      inputSchema: listProductDraftsInputSchema,
      outputSchema: {
        list: z.array(productDraftSchema),
        pagination: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        title: "List WJ product drafts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is listing product drafts",
        "openai/toolInvocation/invoked": "WJ product drafts listed",
      }),
    },
    async (rawInput) => {
      try {
        const input = listProductDraftsInputSchema.parse(rawInput);
        const result = await productDraftClient.listProductDrafts(input);
        return {
          structuredContent: result,
          content: [{
            type: "text" as const,
            text: [
              `Found ${result.list.length} draft(s)` + (result.pagination?.total != null ? ` (total ${result.pagination.total}).` : "."),
              ...result.list.slice(0, 20).map((item) => `- ${item.reservedSku || item.sku || item.id}: ${item.nameCn || item.nameEn || "(unnamed)"}`),
            ].join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "list_product_drafts" }, "MCP product draft list failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "validate_product_draft",
    {
      title: "Validate WJ product draft",
      description:
        "Check whether a draft has all fields required for eventual ERP product creation. Does not publish. Share missing fields with the user.",
      inputSchema: validateProductDraftInputSchema,
      outputSchema: validateProductDraftResultSchema.shape,
      annotations: {
        title: "Validate WJ product draft",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: toolSecurityMeta({
        "openai/toolInvocation/invoking": "WJ is validating a product draft",
        "openai/toolInvocation/invoked": "WJ product draft validated",
      }),
    },
    async (rawInput) => {
      try {
        const input = validateProductDraftInputSchema.parse(rawInput);
        const result = await productDraftClient.validateProductDraft(input);
        const { validation } = result;
        return {
          structuredContent: result,
          content: [{
            type: "text" as const,
            text: validation.ok
              ? "Draft looks complete for ERP creation. Reminder: MCP does not publish; the user must create the product manually in ERP/Etsy."
              : [
                "Draft is incomplete for ERP creation.",
                validation.missing.length ? `Missing: ${validation.missing.join(", ")}` : "",
                validation.errors.length ? `Errors: ${validation.errors.join("; ")}` : "",
                validation.warnings.length ? `Warnings: ${validation.warnings.join("; ")}` : "",
              ].filter(Boolean).join("\n"),
          }],
        };
      } catch (error) {
        logger.warn({ err: error, tool: "validate_product_draft" }, "MCP product draft validate failed");
        return { isError: true as const, content: [{ type: "text" as const, text: toSafeToolError(error) }] };
      }
    },
  );

  registerAppTool(
    server,
    "get_image_result",
    {
      title: "恢复 WJ 图片结果",
      description:
        "Recover a WJ image by resultId or jobId when the image component failed to load or is missing. Prefer result_id for completed results. If only a jobId is available, pass job_id (optionally with wait_ms). Do not call this while the original generate_image component is still loading or already showing images. Returns structured data and plain-text HTTPS links for the model; it does not mount an image component. Read-only; does not consume WJ image quota.",
      inputSchema: {
        result_id: z.string().min(1).optional().describe("Completed resultId from an earlier WJ image job."),
        job_id: z.string().min(1).optional().describe("JobId from generate_image when resultId is not yet known."),
        wait_ms: z.number().int().min(0).max(45_000).optional()
          .describe("When using job_id, optional long-poll budget in milliseconds (0–45000)."),
      },
      outputSchema: imageOutputSchema,
      annotations: {
        title: "恢复 WJ 图片结果",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: toolSecurityMeta({
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "正在恢复 WJ 图片",
        "openai/toolInvocation/invoked": "WJ 图片已恢复",
      }),
    },
    async (rawInput, extra) => {
      try {
        const input = z.object({
          result_id: z.string().min(1).optional(),
          job_id: z.string().min(1).optional(),
          wait_ms: z.number().int().min(0).max(45_000).optional(),
        }).superRefine((value, ctx) => {
          if (!value.result_id && !value.job_id) {
            ctx.addIssue({ code: "custom", message: "Provide result_id or job_id." });
          }
        }).parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");

        if (input.result_id) {
          const restored = await imageResults.get(subject, input.result_id);
          if (!restored) {
            return {
              isError: true as const,
              content: [{
                type: "text" as const,
                text: "WJ image result was not found, has expired, or belongs to another user.",
              }],
            };
          }
          return buildImageToolResult(restored, "recovered");
        }

        const job = await generation.pollJob(subject, input.job_id!, input.wait_ms ?? 45_000);
        if (!job) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: "WJ image job was not found, has expired, or belongs to another user.",
            }],
          };
        }
        if (job.status === "completed" && job.assets.length > 0) {
          return buildImageToolResult({
            model: job.model,
            resolution: job.resolution,
            aspectRatio: job.aspectRatio,
            ...(job.durationMs === undefined ? {} : { durationMs: job.durationMs }),
            assets: job.assets,
            jobId: job.jobId,
            status: job.status,
            ...(job.resultId ? {
              resultId: job.resultId,
              createdAt: job.resultCreatedAt ?? job.updatedAt,
              expiresAt: job.resultExpiresAt ?? job.expiresAt,
            } : {}),
          }, "recovered", Boolean(job.resultId));
        }
        if (job.status === "failed" || job.status === "timed_out") {
          return {
            isError: true as const,
            structuredContent: {
              model: job.model,
              resolution: job.resolution,
              aspectRatio: job.aspectRatio,
              assets: [],
              jobId: job.jobId,
              status: job.status,
              ...(job.error ? { error: job.error } : {}),
            },
            content: [{
              type: "text" as const,
              text: job.error ?? `WJ image job ${job.jobId} ended with status ${job.status}.`,
            }],
          };
        }
        return {
          structuredContent: {
            model: job.model,
            resolution: job.resolution,
            aspectRatio: job.aspectRatio,
            assets: [],
            jobId: job.jobId,
            status: job.status,
          },
          content: [{
            type: "text" as const,
            text: [
              `WJ image job ${job.jobId} is still ${job.status}.`,
              "Call get_image_result again with the same job_id until status is completed and assets are present.",
              "Do not regenerate. Prefer plain-text HTTPS links only after assets are available.",
            ].join("\n"),
          }],
        };
      } catch (error) {
        const message = toSafeToolError(error);
        logger.warn({ err: error, tool: "get_image_result" }, "MCP image recovery tool failed");
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  registerAppResource(
    server,
    "WJ image result",
    IMAGE_WIDGET_URI,
    {
      description: "Displays generated WJ images inline in the conversation.",
      _meta: widgetResourceMeta(config),
    },
    async () => ({
      contents: [
        {
          uri: IMAGE_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: widgetResourceMeta(config),
        },
      ],
    }),
  );

  return server;
}

function buildImageJobToolResult(job: ImageJobView, phase: "accepted" | "polled") {
  const lines = [
    phase === "accepted"
      ? `WJ accepted image job ${job.jobId} (${job.model}, ${job.resolution}, ${job.aspectRatio}).`
      : `WJ image job ${job.jobId} status: ${job.status}.`,
    `Job expires at ${job.expiresAt} (20-minute window).`,
    "The WJ image component polls this job until completion. Do not claim images are ready until assets are shown.",
    "Never paste markdown image embeds (![](url)).",
  ];
  if (job.status === "completed" && job.assets.length > 0) {
    lines.push(
      ...(job.resultId ? [`Result ID: ${job.resultId}.`] : []),
      `Succeeded: ${job.assets.length} image(s).`,
      ...(job.failures?.length
        ? [
          `Failed: ${job.failures.length} image(s).`,
          ...job.failures.slice(0, 10).map((failure) => `- prompt #${failure.index + 1}: ${failure.error}`),
        ]
        : []),
      "If the component is missing, paste these plain-text HTTPS links (URLs only):",
      ...job.assets.map((asset, index) => `${index + 1}. ${asset.url}`),
    );
  } else if (job.status === "failed" || job.status === "timed_out") {
    lines.push(job.error ?? `Job ended with status ${job.status}.`);
    if (job.failures?.length) {
      lines.push(...job.failures.slice(0, 10).map((failure) => `- prompt #${failure.index + 1}: ${failure.error}`));
    }
  }

  return {
    structuredContent: job,
    content: [{ type: "text" as const, text: lines.join("\n") }],
    _meta: { jobId: job.jobId, status: job.status },
  };
}

function buildImageToolResult(
  structuredContent: (ImageResultData | PersistedImageResult) & {
    jobId?: string;
    status?: string;
    error?: string;
  },
  action: "generated" | "recovered",
  persisted = true,
) {
  const resultId = "resultId" in structuredContent ? structuredContent.resultId : undefined;
  const expiry = "expiresAt" in structuredContent ? structuredContent.expiresAt : undefined;
  const actionText = action === "recovered" ? "recovered" : action;
  const lines = [
    `WJ ${actionText} ${structuredContent.assets.length} image${structuredContent.assets.length === 1 ? "" : "s"} with ${structuredContent.model}.`,
    ...(resultId ? [`Result ID: ${resultId}. Retained until ${expiry}.`] : []),
    ...(persisted ? [] : ["The image was generated successfully, but result persistence failed. Save the original links below."]),
    "Prefer the WJ image component for display. Never paste markdown image embeds (![](url)).",
    "If the component is missing or the user cannot see the images, paste these plain-text HTTPS links in the assistant reply (URLs only):",
    ...structuredContent.assets.map((asset, index) => `${index + 1}. ${asset.url}`),
  ];

  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: lines.join("\n"),
      },
    ],
  };
}

function toSafeToolError(error: unknown): string {
  if (error instanceof UsageLimitError) return error.message;
  if (error instanceof WjApiError) {
    if (error.status === 401 || error.status === 403) return `WJ request was rejected with HTTP ${error.status}: ${error.message}`;
    if (error.status === 429) return "WJ is currently rate-limited. Please try again later.";
    return error.message;
  }
  if (error instanceof z.ZodError) return `Invalid request: ${error.issues[0]?.message ?? "validation failed"}`;
  return "WJ tool request failed unexpectedly. Please try again.";
}

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WJ_IMAGE_SCOPE } from "../auth/provider.js";
import type { AppConfig } from "../config.js";
import type { GenerationService } from "../generation-service.js";
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
  aspectRatioSchema,
  editImageInputSchema,
  generateImageInputSchema,
  imageAssetSchema,
  resolutionSchema,
  type WjImageData,
} from "../wj/types.js";

export const IMAGE_WIDGET_URI = "ui://wj/image-result-v2.html";
export const WJ_IMAGE_SERVER_INSTRUCTIONS = `Use generate_image immediately when the user explicitly asks to use WJ, WJ image generation, or 无界生图. When the user requests multiple images, make one independent generate_image call per image and dispatch all calls concurrently in the same tool-call turn; never wait for one image before starting the next. Reuse the exact prompt for same-prompt variants, or preserve each distinct prompt. Apply the same concurrent-call rule to multiple independent edit_image requests. Use edit_image for explicit WJ edits of ChatGPT attachments. If native ChatGPT image generation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call WJ once without asking again. If a generated result exists but its image component is missing and a resultId is available, call get_image_result to restore and display it without generating again. Use fallback links when recovery is unavailable, and never regenerate solely because UI display failed. Default to gpt-image-2, 2K, and 1:1 unless specified otherwise. Do not claim success unless the tool returns at least one asset.

For profit calculations, call calculate_profit first and clearly explain that the result has not been saved. Never save merely because the user asked for a calculation. Only call save_profit_calculation after the user explicitly confirms that the displayed calculation should be recorded. Recording requires an existing product SKU: if the user has not supplied one, ask for it and never invent it. Use a user-provided calculation name when available; otherwise generate a concise recognizable record_name from the country, product context, and price before saving.`;

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
  ...persistenceOutputSchema,
};

type McpServerDependencies = {
  config: AppConfig;
  generation: GenerationService;
  imageResults: ImageResultStore;
  profitClient: Pick<WjClient, "calculateProfit" | "saveProfitCalculation">;
  logger: AppLogger;
  widgetHtml: string;
};

export function createWjMcpServer(dependencies: McpServerDependencies): McpServer {
  const { config, generation, imageResults, profitClient, logger, widgetHtml } = dependencies;
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
        "Generate and display one image through WJ. For multiple images, call this tool once per image and dispatch all independent calls concurrently rather than serially. Reuse the exact prompt for same-prompt variants. Default to gpt-image-2 and 2K. After a successful call, prefer listing the original image URL in the final assistant response as a plain text link. Each call consumes WJ quota.",
      inputSchema: generateImageInputSchema,
      outputSchema: imageOutputSchema,
      annotations: {
        title: "使用 WJ 生成图片",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: IMAGE_WIDGET_URI },
        "openai/outputTemplate": IMAGE_WIDGET_URI,
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "WJ 正在生成图片",
        "openai/toolInvocation/invoked": "WJ 图片已生成",
      },
    },
    async (rawInput, extra) => {
      try {
        const input = generateImageInputSchema.parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const terminalId = String(extra.authInfo?.extra?.terminalId ?? extra.authInfo?.clientId ?? subject);
        const result = await generation.generate(terminalId, input);
        return await toImageToolResult(
          imageResults,
          logger,
          subject,
          result,
          input.resolution,
          input.aspect_ratio,
          "generated",
        );
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
    "edit_image",
    {
      title: "使用 WJ 编辑图片",
      description:
        "Edit and display one ChatGPT image attachment through WJ. Put the image being changed in target_image and optional style, text, layout, or identity references in reference_images. For multiple independent edits, call this tool once per output and dispatch all calls concurrently rather than serially. After a successful call, prefer listing the original image URL in the final assistant response as a plain text link. Each call consumes WJ image quota.",
      inputSchema: editImageInputSchema,
      outputSchema: imageOutputSchema,
      annotations: {
        title: "使用 WJ 编辑图片",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: IMAGE_WIDGET_URI },
        "openai/outputTemplate": IMAGE_WIDGET_URI,
        "openai/fileParams": ["target_image", "reference_images"],
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "WJ 正在编辑图片",
        "openai/toolInvocation/invoked": "WJ 图片已编辑",
      },
    },
    async (rawInput, extra) => {
      try {
        const input = editImageInputSchema.parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const terminalId = String(extra.authInfo?.extra?.terminalId ?? extra.authInfo?.clientId ?? subject);
        const referenceImageUrls = [
          input.target_image.download_url,
          ...(input.reference_images ?? []).map((file) => file.download_url),
        ];
        const result = await generation.generate(terminalId, {
          prompt: input.prompt,
          model: input.model,
          aspect_ratio: input.aspect_ratio,
          resolution: input.resolution,
          reference_image_urls: referenceImageUrls,
        });
        return await toImageToolResult(
          imageResults,
          logger,
          subject,
          result,
          input.resolution,
          input.aspect_ratio,
          "edited",
        );
      } catch (error) {
        const message = toSafeToolError(error);
        logger.warn({ err: error, tool: "edit_image" }, "MCP image edit tool failed");
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
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "WJ is calculating profit",
        "openai/toolInvocation/invoked": "WJ profit calculation completed",
      },
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
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "WJ is recording the profit calculation",
        "openai/toolInvocation/invoked": "WJ profit calculation recorded",
      },
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
    "get_image_result",
    {
      title: "恢复 WJ 图片结果",
      description:
        "Retrieve and display a previously generated WJ image by resultId when its image component is missing. Always use this instead of regenerating a completed image. This read-only action does not consume WJ image quota. Results are retained for 30 days.",
      inputSchema: {
        result_id: z.string().min(1).describe("The resultId returned by an earlier WJ image tool call."),
      },
      outputSchema: imageOutputSchema,
      annotations: {
        title: "恢复 WJ 图片结果",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: IMAGE_WIDGET_URI },
        "openai/outputTemplate": IMAGE_WIDGET_URI,
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "正在恢复 WJ 图片",
        "openai/toolInvocation/invoked": "WJ 图片已恢复",
      },
    },
    async (rawInput, extra) => {
      try {
        const input = z.object({ result_id: z.string().min(1) }).parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
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
      _meta: {
        ui: {
          prefersBorder: false,
          domain: config.publicBaseUrl.origin,
          csp: { resourceDomains: config.imageResourceDomains },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: IMAGE_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              domain: config.publicBaseUrl.origin,
              csp: { resourceDomains: config.imageResourceDomains },
            },
          },
        },
      ],
    }),
  );

  return server;
}

async function toImageToolResult(
  imageResults: ImageResultStore,
  logger: AppLogger,
  subject: string,
  result: WjImageData,
  fallbackResolution: string,
  fallbackAspectRatio: string,
  action: "generated" | "edited",
) {
  const assets = result.assets.map((asset) => ({
    type: asset.type,
    mime_type: asset.mime_type,
    url: asset.url,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
    ...(asset.revised_prompt ? { revised_prompt: asset.revised_prompt } : {}),
  }));
  const imageResult: ImageResultData = {
    model: result.model_id,
    resolution: result.resolution ?? fallbackResolution,
    aspectRatio: result.aspect_ratio ?? fallbackAspectRatio,
    ...(result.duration_ms === undefined ? {} : { durationMs: result.duration_ms }),
    assets,
  };

  try {
    const persisted = await imageResults.save(subject, imageResult);
    return buildImageToolResult(persisted, action);
  } catch (error) {
    logger.error({ err: error, tool: "persist_image_result" }, "Failed to persist generated image result");
    return buildImageToolResult(imageResult, action, false);
  }
}

function buildImageToolResult(
  structuredContent: ImageResultData | PersistedImageResult,
  action: "generated" | "edited" | "recovered",
  persisted = true,
) {
  const resultId = "resultId" in structuredContent ? structuredContent.resultId : undefined;
  const expiry = "expiresAt" in structuredContent ? structuredContent.expiresAt : undefined;
  const actionText = action === "recovered" ? "recovered" : action;
  const lines = [
    `WJ ${actionText} ${structuredContent.assets.length} image${structuredContent.assets.length === 1 ? "" : "s"} with ${structuredContent.model}.`,
    ...(resultId ? [`Result ID: ${resultId}. Retained until ${expiry}.`] : []),
    ...(persisted ? [] : ["The image was generated successfully, but result persistence failed. Save the original links below."]),
    "If the WJ component is unavailable, use these original image links. Do not regenerate solely because the component did not display:",
    ...structuredContent.assets.map((asset, index) => `${index + 1}. [Open original image ${index + 1}](${asset.url})`),
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

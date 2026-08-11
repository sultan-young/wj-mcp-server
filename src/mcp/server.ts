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
import { WjApiError } from "../wj/client.js";
import {
  aspectRatioSchema,
  editImageInputSchema,
  generateImageInputSchema,
  generateImagesInputSchema,
  imageAssetSchema,
  resolutionSchema,
  type GenerateImageRequest,
  type WjImageData,
} from "../wj/types.js";

export const IMAGE_WIDGET_URI = "ui://wj/image-result-v2.html";
export const WJ_IMAGE_SERVER_INSTRUCTIONS = `Use generate_image immediately when the user explicitly asks to use WJ, WJ image generation, or 无界生图. For multiple variants of the same prompt, make one generate_image call with count. For multiple different prompts, make one generate_images call with all requests so the server can run them concurrently; do not serialize repeated generate_image calls. Use edit_image for explicit WJ edits of ChatGPT attachments. If a generated result exists but its component is missing, use its fallback links or call get_image_result with resultId; never regenerate solely because UI display failed. If native ChatGPT image generation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call WJ once without asking again. Default to gpt-image-2, 2K, and 1:1 unless specified otherwise. Do not claim success unless the tool returns at least one asset.`;

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
  requestedCount: z.number().int().positive().optional(),
  completedCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  ...persistenceOutputSchema,
};

const batchImageOutputSchema = {
  ...imageOutputSchema,
  requestedCount: z.number().int().positive(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
};

type McpServerDependencies = {
  config: AppConfig;
  generation: GenerationService;
  imageResults: ImageResultStore;
  logger: AppLogger;
  widgetHtml: string;
};

export function createWjMcpServer(dependencies: McpServerDependencies): McpServer {
  const { config, generation, imageResults, logger, widgetHtml } = dependencies;
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
        "Generate and display images through WJ. For multiple variants with the same prompt, set count in this single call instead of calling the tool repeatedly. Use generate_images for multiple different prompts. Default to gpt-image-2 and 2K. Each generated image consumes WJ quota.",
      inputSchema: generateImageInputSchema,
      outputSchema: batchImageOutputSchema,
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
        const { count = 1, ...request } = input;
        const batch = await runImageBatch(generation, subject, Array.from({ length: count }, () => request));
        logPartialBatch(logger, "generate_image", batch);
        return await toImageToolResult(
          imageResults,
          logger,
          subject,
          batch.result,
          input.resolution,
          input.aspect_ratio,
          "generated",
          batch,
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
    "generate_images",
    {
      title: "使用 WJ 并发生成多张图片",
      description:
        "Generate and display multiple images with different prompts through WJ. Put every distinct prompt in requests and call this tool once; the server runs the requests concurrently. Do not call generate_image repeatedly and wait between calls. Each request consumes WJ quota.",
      inputSchema: generateImagesInputSchema,
      outputSchema: batchImageOutputSchema,
      annotations: {
        title: "使用 WJ 并发生成多张图片",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: IMAGE_WIDGET_URI },
        "openai/outputTemplate": IMAGE_WIDGET_URI,
        securitySchemes: [{ type: "oauth2", scopes: [WJ_IMAGE_SCOPE] }],
        "openai/toolInvocation/invoking": "WJ 正在并发生成图片",
        "openai/toolInvocation/invoked": "WJ 图片已生成",
      },
    },
    async (rawInput, extra) => {
      try {
        const input = generateImagesInputSchema.parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const batch = await runImageBatch(generation, subject, input.requests);
        logPartialBatch(logger, "generate_images", batch);
        return await toImageToolResult(imageResults, logger, subject, batch.result, "mixed", "mixed", "generated", batch);
      } catch (error) {
        const message = toSafeToolError(error);
        logger.warn({ err: error, tool: "generate_images" }, "MCP batch image tool failed");
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
        "Edit and display ChatGPT image attachments through WJ. Put the image being changed in target_image and optional style, text, layout, or identity references in reference_images. Use this tool for explicit WJ image-editing requests instead of asking for public URLs. This action consumes WJ image quota.",
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
        const referenceImageUrls = [
          input.target_image.download_url,
          ...(input.reference_images ?? []).map((file) => file.download_url),
        ];
        const result = await generation.generate(subject, {
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
    "get_image_result",
    {
      title: "恢复 WJ 图片结果",
      description:
        "Retrieve and display a previously generated WJ image result by resultId without generating again or consuming WJ image quota. Use this when an earlier image component did not display or needs to be restored. Results are retained for 30 days.",
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
  batch?: ImageBatchResult,
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
    ...(batch ? {
      requestedCount: batch.requestedCount,
      completedCount: batch.completedCount,
      failedCount: batch.failedCount,
    } : {}),
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
    ...(structuredContent.failedCount
      ? [`${structuredContent.failedCount} of ${structuredContent.requestedCount ?? structuredContent.assets.length + structuredContent.failedCount} requests failed; successful images are preserved.`]
      : []),
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

type ImageBatchResult = {
  result: WjImageData;
  requestedCount: number;
  completedCount: number;
  failedCount: number;
};

async function runImageBatch(
  generation: GenerationService,
  subject: string,
  requests: GenerateImageRequest[],
): Promise<ImageBatchResult> {
  const startedAt = Date.now();
  const settled = await Promise.allSettled(requests.map((request) => generation.generate(subject, request)));
  const completed = settled.flatMap((item, index) => item.status === "fulfilled"
    ? [{ result: item.value, request: requests[index]! }]
    : []);

  if (completed.length === 0) {
    const firstFailure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    throw firstFailure?.reason ?? new Error("WJ batch generation returned no images");
  }

  return {
    result: {
      model_id: summarizeValues(completed.map(({ result }) => result.model_id)),
      resolution: summarizeValues(completed.map(({ result, request }) => result.resolution ?? request.resolution)),
      aspect_ratio: summarizeValues(completed.map(({ result, request }) => result.aspect_ratio ?? request.aspect_ratio)),
      duration_ms: Date.now() - startedAt,
      assets: completed.flatMap(({ result }) => result.assets),
    },
    requestedCount: requests.length,
    completedCount: completed.length,
    failedCount: requests.length - completed.length,
  };
}

function summarizeValues(values: string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] ?? "unknown" : "mixed";
}

function logPartialBatch(logger: AppLogger, tool: string, batch: ImageBatchResult): void {
  if (batch.failedCount > 0) {
    logger.warn(
      { tool, requestedCount: batch.requestedCount, completedCount: batch.completedCount, failedCount: batch.failedCount },
      "MCP image batch partially failed",
    );
  }
}

function toSafeToolError(error: unknown): string {
  if (error instanceof UsageLimitError) return error.message;
  if (error instanceof WjApiError) {
    if (error.status === 401 || error.status === 403) return `WJ request was rejected with HTTP ${error.status}: ${error.message}`;
    if (error.status === 429) return "WJ is currently rate-limited. Please try again later.";
    return error.message;
  }
  if (error instanceof z.ZodError) return `Invalid image request: ${error.issues[0]?.message ?? "validation failed"}`;
  return "WJ image generation failed unexpectedly. Please try again.";
}

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WJ_IMAGE_SCOPE } from "../auth/provider.js";
import type { AppConfig } from "../config.js";
import type { GenerationService } from "../generation-service.js";
import { UsageLimitError } from "../limits.js";
import type { AppLogger } from "../logger.js";
import { WjApiError } from "../wj/client.js";
import {
  aspectRatioSchema,
  editImageInputSchema,
  generateImageInputSchema,
  imageAssetSchema,
  resolutionSchema,
  type WjImageData,
} from "../wj/types.js";

export const IMAGE_WIDGET_URI = "ui://wj/image-result-v2.html";
export const LEGACY_IMAGE_WIDGET_URIS = ["ui://wj/image-result.html"] as const;
export const IMAGE_WIDGET_URIS = [IMAGE_WIDGET_URI, ...LEGACY_IMAGE_WIDGET_URIS] as const;
export const WJ_IMAGE_SERVER_INSTRUCTIONS = `Use generate_image immediately when the user explicitly asks to use WJ, WJ image generation, or 无界生图. Use edit_image immediately when the user explicitly asks WJ to edit ChatGPT image attachments. Map the image being changed to target_image and style, text, layout, or identity references to reference_images; preserve attachment order for labels such as image one and image two. Do not ask for public image URLs when ChatGPT attachments are available. If a native ChatGPT image-generation attempt in the current conversation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call generate_image once without asking the user again. Default to gpt-image-2, 1K, and 1:1 unless the user specifies supported alternatives. Preserve the user's prompt and requested image settings when falling back. Do not claim to know the user's native ChatGPT image quota, do not force WJ for generic image requests when no native failure is visible, and do not claim an image was generated unless the tool returns at least one asset. After success, rely on the associated WJ image component to display the result.`;

type McpServerDependencies = {
  config: AppConfig;
  generation: GenerationService;
  logger: AppLogger;
  widgetHtml: string;
};

export function createWjMcpServer(dependencies: McpServerDependencies): McpServer {
  const { config, generation, logger, widgetHtml } = dependencies;
  const server = new McpServer(
    { name: "wj-mcp-server", version: "0.1.0" },
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
        "Generate and display an image through WJ. Use this tool when the user explicitly asks for WJ image generation, or when native image generation is unavailable or rate-limited. Default to gpt-image-2. This action consumes WJ image quota.",
      inputSchema: generateImageInputSchema,
      outputSchema: {
        model: z.string(),
        resolution: resolutionSchema.or(z.string()),
        aspectRatio: aspectRatioSchema.or(z.string()),
        durationMs: z.number().int().nonnegative().optional(),
        assets: z.array(imageAssetSchema),
      },
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
        const result = await generation.generate(subject, input);
        return toImageToolResult(result, input.resolution, input.aspect_ratio, "generated");
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
        "Edit and display ChatGPT image attachments through WJ. Put the image being changed in target_image and optional style, text, layout, or identity references in reference_images. Use this tool for explicit WJ image-editing requests instead of asking for public URLs. This action consumes WJ image quota.",
      inputSchema: editImageInputSchema,
      outputSchema: {
        model: z.string(),
        resolution: resolutionSchema.or(z.string()),
        aspectRatio: aspectRatioSchema.or(z.string()),
        durationMs: z.number().int().nonnegative().optional(),
        assets: z.array(imageAssetSchema),
      },
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
        return toImageToolResult(result, input.resolution, input.aspect_ratio, "edited");
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

  // Keep old resource URIs readable because installed ChatGPT connectors cache them.
  for (const resourceUri of IMAGE_WIDGET_URIS) {
    registerAppResource(
      server,
      `WJ image result (${resourceUri})`,
      resourceUri,
      {
        description: "Displays generated WJ images inline in the conversation.",
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { resourceDomains: config.imageResourceDomains },
          },
        },
      },
      async () => ({
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: widgetHtml,
            _meta: {
              ui: {
                prefersBorder: false,
                csp: { resourceDomains: config.imageResourceDomains },
              },
            },
          },
        ],
      }),
    );
  }

  return server;
}

function toImageToolResult(
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
  const structuredContent = {
    model: result.model_id,
    resolution: result.resolution ?? fallbackResolution,
    aspectRatio: result.aspect_ratio ?? fallbackAspectRatio,
    ...(result.duration_ms === undefined ? {} : { durationMs: result.duration_ms }),
    assets,
  };
  const links = assets.map((asset, index) => `![WJ ${action} image ${index + 1}](${asset.url})\n${asset.url}`).join("\n\n");

  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: `WJ ${action} ${assets.length} image${assets.length === 1 ? "" : "s"} with ${result.model_id}.\n\n${links}`,
      },
      ...assets.map((asset, index) => ({
        type: "resource_link" as const,
        uri: asset.url,
        name: `wj-image-${index + 1}`,
        title: `WJ 图片 ${index + 1}`,
        mimeType: asset.mime_type,
      })),
    ],
  };
}

function toSafeToolError(error: unknown): string {
  if (error instanceof UsageLimitError) return error.message;
  if (error instanceof WjApiError) {
    if (error.status === 401 || error.status === 403) return "WJ rejected the server API key. Ask the service owner to update WJ_API_KEY.";
    if (error.status === 429) return "WJ is currently rate-limited. Please try again later.";
    return error.message;
  }
  if (error instanceof z.ZodError) return `Invalid image request: ${error.issues[0]?.message ?? "validation failed"}`;
  return "WJ image generation failed unexpectedly. Please try again.";
}

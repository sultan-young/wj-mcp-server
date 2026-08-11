import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { GenerationService } from "../generation-service.js";
import { UsageLimitError } from "../limits.js";
import type { AppLogger } from "../logger.js";
import { WjApiError } from "../wj/client.js";
import { aspectRatioSchema, generateImageInputSchema, imageAssetSchema, resolutionSchema } from "../wj/types.js";

export const IMAGE_WIDGET_URI = "ui://wj/image-result.html";

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
    { capabilities: { tools: {}, resources: {} } },
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
        ui: { resourceUri: IMAGE_WIDGET_URI, visibility: ["model"] },
        "openai/toolInvocation/invoking": "WJ 正在生成图片",
        "openai/toolInvocation/invoked": "WJ 图片已生成",
      },
    },
    async (rawInput, extra) => {
      try {
        const input = generateImageInputSchema.parse(rawInput);
        const subject = String(extra.authInfo?.extra?.subject ?? "wj-shared-access");
        const result = await generation.generate(subject, input);
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
          resolution: result.resolution ?? input.resolution,
          aspectRatio: result.aspect_ratio ?? input.aspect_ratio,
          ...(result.duration_ms === undefined ? {} : { durationMs: result.duration_ms }),
          assets,
        };
        const links = assets.map((asset, index) => `![WJ generated image ${index + 1}](${asset.url})\n${asset.url}`).join("\n\n");

        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `WJ generated ${assets.length} image${assets.length === 1 ? "" : "s"} with ${result.model_id}.\n\n${links}`,
            },
            ...assets.map((asset, index) => ({
              type: "resource_link" as const,
              uri: asset.url,
              name: `wj-image-${index + 1}`,
              title: `WJ 生成图片 ${index + 1}`,
              mimeType: asset.mime_type,
            })),
          ],
        };
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

  registerAppResource(
    server,
    "WJ image result",
    IMAGE_WIDGET_URI,
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
          uri: IMAGE_WIDGET_URI,
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

  return server;
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

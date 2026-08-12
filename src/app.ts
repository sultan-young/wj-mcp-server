import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { HttpLogger, Options as PinoHttpOptions } from "pino-http";

import { createAuthServices, WJ_IMAGE_SCOPE } from "./auth/provider.js";
import type { AppConfig } from "./config.js";
import { GenerationService } from "./generation-service.js";
import { ImageResultStore } from "./image-result-store.js";
import { UsageLimitError, UsageLimits } from "./limits.js";
import type { AppLogger } from "./logger.js";
import { createWjMcpServer } from "./mcp/server.js";
import type { RedisClient } from "./redis.js";
import { WjClient } from "./wj/client.js";

const require = createRequire(import.meta.url);
const pinoHttp = require("pino-http") as (options: PinoHttpOptions) => HttpLogger;

type AppDependencies = {
  config: AppConfig;
  logger: AppLogger;
  redis: RedisClient;
  fetchImpl?: typeof fetch;
  widgetHtml?: string;
};

export async function createApplication(dependencies: AppDependencies) {
  const { config, logger, redis } = dependencies;
  const widgetHtml = dependencies.widgetHtml ?? await readFile(resolve(process.cwd(), "dist/ui/image-result.html"), "utf8");
  const limits = new UsageLimits(redis, config);
  const wjClient = new WjClient(config, logger, dependencies.fetchImpl);
  const generation = new GenerationService(wjClient, config);
  const imageResults = new ImageResultStore(redis, config.IMAGE_RESULT_TTL_SECONDS);
  const auth = createAuthServices(config, redis, limits, logger);
  const app = createMcpExpressApp({ host: config.HOST, allowedHosts: config.ALLOWED_HOSTS });

  if (config.TRUST_PROXY) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(pinoHttp({ logger }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/", (_req, res) => res.status(200).json({
    name: "WJ MCP Server",
    mcp: config.mcpUrl.href,
    authentication: "OAuth 2.1 with PKCE",
  }));
  app.get("/readyz", asyncHandler(async (_req, res) => {
    await redis.ping();
    res.status(200).json({ status: "ready" });
  }));

  const protectedResourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", config.publicBaseUrl);
  app.get(protectedResourceMetadataUrl.pathname, (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      resource: config.mcpUrl.href,
      authorization_servers: [config.publicBaseUrl.origin],
      scopes_supported: [WJ_IMAGE_SCOPE],
      resource_name: "WJ Tools",
      resource_documentation: new URL("/", config.publicBaseUrl).href,
    });
  });

  app.use(mcpAuthMetadataRouter({
    oauthMetadata: auth.oauthMetadata,
    resourceServerUrl: config.mcpUrl,
    serviceDocumentationUrl: new URL("/", config.publicBaseUrl),
    scopesSupported: [WJ_IMAGE_SCOPE],
    resourceName: "WJ Tools",
  }));
  app.use(auth.interactionRouter);
  app.post("/reg", (req, res, next) => {
    void limits.consumeRegistration(req.ip ?? req.socket.remoteAddress ?? "unknown")
      .then(() => next())
      .catch((error: unknown) => {
        if (error instanceof UsageLimitError) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
          res.status(429).json({ error: "too_many_requests", error_description: error.message });
          return;
        }
        next(error);
      });
  });

  const authenticate = requireBearerAuth({
    verifier: auth.verifier,
    requiredScopes: [WJ_IMAGE_SCOPE],
    resourceMetadataUrl: protectedResourceMetadataUrl.href,
  });
  const mcpBody = express.json({ limit: "1mb" });

  app.post("/mcp", authenticate, mcpBody, asyncHandler(async (req, res) => {
    const mcpServer = createWjMcpServer({ config, generation, imageResults, profitClient: wjClient, logger, widgetHtml });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
  app.get("/mcp", authenticate, (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", authenticate, (_req, res) => methodNotAllowed(res));

  app.use(auth.provider.callback());
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: error }, "Unhandled HTTP error");
    if (!res.headersSent) res.status(500).json({ error: "internal_server_error" });
  });

  return app;
}

function methodNotAllowed(res: Response): void {
  res.setHeader("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed. This server uses stateless Streamable HTTP POST requests." },
    id: null,
  });
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

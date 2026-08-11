import "dotenv/config";

import { createServer } from "node:http";

import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRedisClient } from "./redis.js";

const config = loadConfig();
const logger = createLogger(config);
const redis = await createRedisClient(config, logger);
const app = await createApplication({ config, logger, redis });
const server = createServer(app);

server.keepAliveTimeout = 70_000;
server.headersTimeout = 75_000;

server.listen(config.PORT, config.HOST, () => {
  logger.info(
    { host: config.HOST, port: config.PORT, mcpUrl: config.mcpUrl.href },
    "WJ MCP server listening",
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down WJ MCP server");
  server.close(async (error) => {
    if (error) logger.error({ err: error }, "HTTP server close failed");
    await redis.quit().catch((redisError) => logger.error({ err: redisError }, "Redis close failed"));
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

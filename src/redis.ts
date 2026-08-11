import { createClient } from "redis";

import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";

export type RedisClient = ReturnType<typeof createClient>;

export async function createRedisClient(config: AppConfig, logger: AppLogger): Promise<RedisClient> {
  const client = createClient({ url: config.REDIS_URL });
  client.on("error", (error) => logger.error({ err: error }, "Redis error"));
  client.on("reconnecting", () => logger.warn("Redis reconnecting"));
  await client.connect();
  await client.ping();
  return client;
}

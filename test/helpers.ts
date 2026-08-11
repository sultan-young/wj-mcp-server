import { loadConfig, type AppConfig } from "../src/config.js";
import { ImageResultStore } from "../src/image-result-store.js";
import { createLogger } from "../src/logger.js";
import type { RedisClient } from "../src/redis.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "http://127.0.0.1:6070",
    ALLOWED_HOSTS: "127.0.0.1,localhost",
    WJ_API_BASE_URL: "https://wj.example.com",
    WJ_API_KEY: "wj_test_secret",
    MCP_SHARED_PASSWORD: "a-secure-shared-password",
    OAUTH_COOKIE_KEYS: `${"a".repeat(32)},${"b".repeat(32)}`,
    OAUTH_JWKS: JSON.stringify({ keys: [{
      kty: "EC",
      x: "3vYrZkstlGwAr-nAP-vqvljDndiEQQUK2q23-jjzttc",
      y: "OF1FB3D3RUG0KXDkUmHqma7FAjn0ezfqtO_lsFDioF8",
      crv: "P-256",
      d: "2QXvIsDskQW8oDOPQxg6BVXIWev1BUUeHXRzMDuPPgM",
      use: "sig",
      alg: "ES256",
      kid: "test-signing-key",
    }] }),
    REDIS_URL: "redis://127.0.0.1:6379",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export function testLogger() {
  return createLogger({ LOG_LEVEL: "silent" });
}

export function testImageResultStore(ttlSeconds = 2_592_000): ImageResultStore {
  const records = new Map<string, string>();
  const redis = {
    set: async (key: string, value: string) => {
      records.set(key, value);
      return "OK";
    },
    get: async (key: string) => records.get(key) ?? null,
  } as unknown as RedisClient;
  return new ImageResultStore(redis, ttlSeconds);
}

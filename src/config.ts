import { z } from "zod";

const booleanFromString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.toLowerCase() === "true";
}, z.boolean());

const csv = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(6070),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:6070"),
  TRUST_PROXY: booleanFromString.default(false),
  ALLOWED_HOSTS: csv.default(["127.0.0.1", "localhost"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  WJ_API_BASE_URL: z.string().url().default("https://wj.zaowuwujie.ltd"),
  WJ_API_KEY: z.string().min(1),
  WJ_IMAGE_PATH: z.string().startsWith("/").default("/api/v1/proxy/ai/generate/image"),
  WJ_DEFAULT_MODEL: z.enum(["gpt-image-2", "nano-banana-2"]).default("gpt-image-2"),
  WJ_ALLOWED_MODELS: csv.default(["gpt-image-2", "nano-banana-2"]),
  WJ_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(330_000),

  MCP_SHARED_PASSWORD: z.string().min(12),
  OAUTH_COOKIE_KEYS: csv.refine((keys) => keys.length >= 2 && keys.every((key) => key.length >= 32), {
    message: "OAUTH_COOKIE_KEYS must contain at least two comma-separated keys of 32+ characters",
  }),
  OAUTH_JWKS: z.string().optional(),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3600),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(31_536_000).default(2_592_000),

  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  IMAGE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(5),
  IMAGE_DAILY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(100),
  IMAGE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(5),
  IMAGE_RESULT_TTL_SECONDS: z.coerce.number().int().min(86_400).max(31_536_000).default(2_592_000),
  LOGIN_ATTEMPTS_PER_15_MINUTES: z.coerce.number().int().min(1).max(1000).default(10),
  REGISTRATIONS_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(200),
  IMAGE_RESOURCE_DOMAINS: csv.default(["https://img.downk.cc"]),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const publicBaseUrl = new URL(parsed.PUBLIC_BASE_URL);
  const wjApiBaseUrl = new URL(parsed.WJ_API_BASE_URL);

  if (publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path, query, or fragment");
  }

  if (parsed.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use https in production");
  }

  const oauthJwks = parseJwks(parsed.OAUTH_JWKS);
  if (parsed.NODE_ENV === "production" && !oauthJwks) {
    throw new Error("OAUTH_JWKS is required in production; run pnpm secrets to generate it");
  }
  if (parsed.NODE_ENV === "production" && parsed.MCP_SHARED_PASSWORD.toLowerCase().includes("change-me")) {
    throw new Error("MCP_SHARED_PASSWORD must be changed before production deployment");
  }

  if (!parsed.WJ_ALLOWED_MODELS.includes(parsed.WJ_DEFAULT_MODEL)) {
    throw new Error("WJ_DEFAULT_MODEL must be present in WJ_ALLOWED_MODELS");
  }

  const mcpUrl = new URL("/mcp", publicBaseUrl);
  const resourceDomains = new Set(parsed.IMAGE_RESOURCE_DOMAINS);
  resourceDomains.add(wjApiBaseUrl.origin);

  return {
    ...parsed,
    publicBaseUrl,
    mcpUrl,
    wjApiBaseUrl,
    oauthJwks,
    imageResourceDomains: [...resourceDomains],
  };
}

function parseJwks(value: string | undefined): { keys: Array<Record<string, unknown>> } | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OAUTH_JWKS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("keys" in parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error("OAUTH_JWKS must contain a non-empty keys array");
  }
  if (!parsed.keys.every((key) => key && typeof key === "object" && "d" in key)) {
    throw new Error("OAUTH_JWKS must contain private signing keys");
  }
  return { keys: parsed.keys as Array<Record<string, unknown>> };
}

import pino from "pino";

import type { AppConfig } from "./config.js";

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL">) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.body.password",
        "WJ_API_KEY",
        "MCP_SHARED_PASSWORD",
        "OAUTH_COOKIE_KEYS",
      ],
      censor: "[REDACTED]",
    },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;

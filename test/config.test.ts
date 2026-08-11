import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("loadConfig", () => {
  it("derives the MCP URL and defaults to gpt-image-2", () => {
    const config = testConfig();
    expect(config.mcpUrl.href).toBe("http://127.0.0.1:6070/mcp");
    expect(config.WJ_DEFAULT_MODEL).toBe("gpt-image-2");
    expect(config.REGISTRATIONS_PER_HOUR).toBe(200);
    expect(config.imageResourceDomains).toContain("https://wj.example.com");
  });

  it("rejects an HTTP public URL in production", () => {
    expect(() => testConfig({ NODE_ENV: "production" })).toThrow("PUBLIC_BASE_URL must use https");
  });

  it("requires strong rotating cookie keys", () => {
    expect(() => loadConfig({
      WJ_API_KEY: "key",
      MCP_SHARED_PASSWORD: "a-secure-shared-password",
      OAUTH_COOKIE_KEYS: "too-short",
    })).toThrow("OAUTH_COOKIE_KEYS");
  });
});

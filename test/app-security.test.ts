import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApplication } from "../src/app.js";
import type { RedisClient } from "../src/redis.js";
import { testConfig, testLogger } from "./helpers.js";

describe("HTTP security and discovery", () => {
  it("keeps /mcp protected and publishes OAuth metadata", async () => {
    const redis = {
      ping: vi.fn().mockResolvedValue("PONG"),
      on: vi.fn(),
    } as unknown as RedisClient;
    const app = await createApplication({
      config: testConfig(),
      logger: testLogger(),
      redis,
      widgetHtml: "<!doctype html><p>widget</p>",
    });

    await request(app).get("/healthz").expect(200, { status: "ok" });
    await request(app).get("/readyz").expect(200, { status: "ready" });

    const unauthorized = await request(app)
      .post("/mcp")
      .set("host", "127.0.0.1")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("resource_metadata=\"http://127.0.0.1:6070/.well-known/oauth-protected-resource/mcp\"");

    const protectedMetadata = await request(app)
      .get("/.well-known/oauth-protected-resource/mcp")
      .set("host", "127.0.0.1")
      .expect(200);
    expect(protectedMetadata.body).toEqual(expect.objectContaining({
      resource: "http://127.0.0.1:6070/mcp",
      authorization_servers: ["http://127.0.0.1:6070"],
      scopes_supported: ["wj:image"],
    }));

    const oauthMetadata = await request(app)
      .get("/.well-known/oauth-authorization-server")
      .set("host", "127.0.0.1")
      .expect(200);
    expect(oauthMetadata.body).toEqual(expect.objectContaining({
      issuer: "http://127.0.0.1:6070",
      registration_endpoint: "http://127.0.0.1:6070/reg",
      code_challenge_methods_supported: ["S256"],
    }));
  });
});

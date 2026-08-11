import { createHash } from "node:crypto";

import express from "express";
import request, { type Response } from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAuthServices } from "../src/auth/provider.js";
import type { UsageLimits } from "../src/limits.js";
import type { RedisClient } from "../src/redis.js";
import { testConfig, testLogger } from "./helpers.js";

describe("OAuth flow", () => {
  it("requires the shared password and completes DCR + PKCE + token verification", async () => {
    const config = testConfig();
    const redis = new MemoryRedis() as unknown as RedisClient;
    const limits = {
      consumeLogin: vi.fn().mockResolvedValue(undefined),
      clearLogin: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageLimits;
    const auth = createAuthServices(config, redis, limits, testLogger());
    const app = express();
    app.use(auth.interactionRouter);
    app.use(auth.provider.callback());
    const agent = request.agent(app);

    const redirectUri = "https://client.example.com/oauth/callback";
    const registration = await agent.post("/reg").send({
      redirect_uris: [redirectUri],
      client_name: "WJ test client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    const clientId = String(registration.body.client_id);
    expect(clientId).toBeTruthy();

    const verifier = "test-pkce-verifier-that-is-long-enough-for-oauth-2-1";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "wj:image",
      resource: config.mcpUrl.href,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    });

    const initial = await agent.get(`/auth?${authorize.toString()}`).expect(303);
    const loginPage = await followLocalRedirects(agent, initial, config.publicBaseUrl);
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers["referrer-policy"]).toBe("same-origin");
    expect(loginPage.text).toContain("连接 WJ 生图");
    const interactionPath = new URL(loginPage.request.url, config.publicBaseUrl).pathname;

    await agent
      .post(`${interactionPath}/login`)
      .set("origin", "https://attacker.example.com")
      .type("form")
      .send({ password: config.MCP_SHARED_PASSWORD })
      .expect(403);

    await agent
      .post(`${interactionPath}/login`)
      .set("origin", config.publicBaseUrl.origin)
      .type("form")
      .send({ password: "wrong-password" })
      .expect(401);

    const loggedIn = await agent
      .post(`${interactionPath}/login`)
      .type("form")
      .send({ password: config.MCP_SHARED_PASSWORD })
      .expect(303);
    const consentPage = await followLocalRedirects(agent, loggedIn, config.publicBaseUrl);
    expect(consentPage.status, String(consentPage.headers.location ?? consentPage.text)).toBe(200);
    expect(consentPage.text).toContain("确认授权");
    const consentPath = new URL(consentPage.request.url, config.publicBaseUrl).pathname;

    const confirmed = await agent
      .post(`${consentPath}/confirm`)
      .set("origin", config.publicBaseUrl.origin)
      .type("form")
      .send({})
      .expect(303);
    const callback = await followUntilExternal(agent, confirmed, config.publicBaseUrl);
    const callbackUrl = new URL(String(callback.headers.location));
    expect(callbackUrl.origin).toBe("https://client.example.com");
    expect(callbackUrl.searchParams.get("state")).toBe("test-state");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: config.mcpUrl.href,
      })
      .expect(200);
    expect(tokenResponse.body).toEqual(expect.objectContaining({
      token_type: "Bearer",
      scope: "wj:image",
    }));
    expect(tokenResponse.body.access_token).toBeTruthy();
    expect(tokenResponse.body.refresh_token).toBeTruthy();

    const verified = await auth.verifier.verifyAccessToken(String(tokenResponse.body.access_token));
    expect(verified.clientId).toBe(clientId);
    expect(verified.extra?.terminalId).toEqual(expect.any(String));
    expect(verified.scopes).toContain("wj:image");
    expect(verified.resource?.href).toBe(config.mcpUrl.href);
  }, 20_000);
});

async function followLocalRedirects(
  agent: ReturnType<typeof request.agent>,
  start: Response,
  baseUrl: URL,
): Promise<Response> {
  let response = start;
  for (let index = 0; index < 8 && response.status >= 300 && response.status < 400; index += 1) {
    const location = response.headers.location;
    if (!location) break;
    const target = new URL(String(location), baseUrl);
    if (!isLocalTestTarget(target, baseUrl)) break;
    response = await agent.get(`${target.pathname}${target.search}`);
  }
  return response;
}

async function followUntilExternal(
  agent: ReturnType<typeof request.agent>,
  start: Response,
  baseUrl: URL,
): Promise<Response> {
  let response = start;
  for (let index = 0; index < 8; index += 1) {
    const location = response.headers.location;
    if (!location) return response;
    const target = new URL(String(location), baseUrl);
    if (!isLocalTestTarget(target, baseUrl)) return response;
    response = await agent.get(`${target.pathname}${target.search}`);
  }
  throw new Error("Too many OAuth redirects");
}

function isLocalTestTarget(target: URL, configuredBase: URL): boolean {
  return target.origin === configuredBase.origin || target.hostname === "127.0.0.1" || target.hostname === "localhost";
}

class MemoryRedis {
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.values.set(key, value);
    return "OK";
  }

  async del(keys: string | string[]): Promise<number> {
    const list = Array.isArray(keys) ? keys : [keys];
    let count = 0;
    for (const key of list) {
      if (this.values.delete(key)) count += 1;
      if (this.sets.delete(key)) count += 1;
    }
    return count;
  }

  async sAdd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const previousSize = set.size;
    set.add(value);
    this.sets.set(key, set);
    return set.size - previousSize;
  }

  async sRem(key: string, value: string): Promise<number> {
    return this.sets.get(key)?.delete(value) ? 1 : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async expire(): Promise<number> {
    return 1;
  }
}

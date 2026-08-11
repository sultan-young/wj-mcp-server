import { timingSafeEqual, createHash } from "node:crypto";

import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import Provider, { errors, type AdapterConstructor, type Configuration, type Grant } from "oidc-provider";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import type { AppConfig } from "../config.js";
import { UsageLimitError, type UsageLimits } from "../limits.js";
import type { AppLogger } from "../logger.js";
import type { RedisClient } from "../redis.js";
import { createOidcRedisAdapter } from "./redis-adapter.js";

const SHARED_ACCOUNT_ID = "wj-shared-access";
const REQUIRED_SCOPE = "wj:image";

type InteractionDetails = Awaited<ReturnType<Provider["interactionDetails"]>>;

export type AuthServices = {
  provider: Provider;
  verifier: OAuthTokenVerifier;
  interactionRouter: Router;
  oauthMetadata: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    revocation_endpoint: string;
    response_types_supported: string[];
    grant_types_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    scopes_supported: string[];
    code_challenge_methods_supported: string[];
  };
};

export function createAuthServices(
  config: AppConfig,
  redis: RedisClient,
  limits: UsageLimits,
  logger: AppLogger,
): AuthServices {
  const issuer = config.publicBaseUrl.origin;
  const mcpResource = config.mcpUrl.href;
  const Adapter = createOidcRedisAdapter(redis, config.OAUTH_REFRESH_TOKEN_TTL_SECONDS) as AdapterConstructor;

  const providerConfiguration: Configuration = {
    adapter: Adapter,
    clients: [],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      id_token_signed_response_alg: "ES256",
    },
    cookies: {
      keys: config.OAUTH_COOKIE_KEYS,
      long: { signed: true, httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production" },
      short: { signed: true, httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production" },
    },
    claims: { openid: ["sub"] },
    conformIdTokenClaims: false,
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => mcpResource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (new URL(resourceIndicator).href !== mcpResource) throw new errors.InvalidTarget();
          return {
            audience: mcpResource,
            scope: REQUIRED_SCOPE,
            accessTokenFormat: "opaque",
            accessTokenTTL: config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
          };
        },
      },
    },
    findAccount: async (_ctx, id) => {
      if (id !== SHARED_ACCOUNT_ID) return undefined;
      return {
        accountId: id,
        claims: async () => ({ sub: id }),
      };
    },
    interactions: {
      url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}`,
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    ...(config.oauthJwks ? { jwks: config.oauthJwks } : {}),
    pkce: {
      methods: ["S256"],
      required: () => true,
    },
    scopes: ["openid", "offline_access", REQUIRED_SCOPE],
    ttl: {
      AccessToken: config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      Grant: config.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      Interaction: 600,
      RefreshToken: config.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      Session: config.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    },
  };

  const provider = new Provider(issuer, providerConfiguration);
  provider.proxy = config.TRUST_PROXY;
  provider.on("server_error", (_ctx, error) => logger.error({ err: error }, "OAuth provider error"));

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(rawToken) {
      const token = await provider.AccessToken.find(rawToken);
      if (!token?.clientId || !token.exp || !token.isValid) {
        throw new InvalidTokenError("Access token is invalid or expired");
      }
      const audiences = Array.isArray(token.aud) ? token.aud : [token.aud];
      if (!audiences.includes(mcpResource)) {
        throw new InvalidTokenError("Access token was not issued for this MCP resource");
      }
      return {
        token: rawToken,
        clientId: token.clientId,
        scopes: [...token.scopes],
        expiresAt: token.exp,
        resource: config.mcpUrl,
        extra: { subject: token.accountId ?? SHARED_ACCOUNT_ID },
      };
    },
  };

  return {
    provider,
    verifier,
    interactionRouter: createInteractionRouter(provider, config, limits, logger),
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/reg`,
      revocation_endpoint: `${issuer}/token/revocation`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: ["openid", "offline_access", REQUIRED_SCOPE],
      code_challenge_methods_supported: ["S256"],
    },
  };
}

function createInteractionRouter(
  provider: Provider,
  config: AppConfig,
  limits: UsageLimits,
  logger: AppLogger,
): Router {
  const router = express.Router();
  const formBody = express.urlencoded({ extended: false, limit: "8kb" });

  router.use((_req, res, next) => {
    setAuthorizationPageHeaders(res);
    next();
  });

  router.get("/oauth/interaction/:uid", asyncHandler(async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const client = await provider.Client.find(String(details.params.client_id));
    res.send(renderInteractionPage(details, client?.clientName));
  }));

  router.post("/oauth/interaction/:uid/login", formBody, verifyFormOrigin(config), asyncHandler(async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name !== "login") throw new Error("Unexpected OAuth interaction prompt");

    await limits.consumeLogin(req.ip ?? req.socket.remoteAddress ?? "unknown");
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!safeEqual(password, config.MCP_SHARED_PASSWORD)) {
      logger.warn({ ip: req.ip }, "OAuth password rejected");
      const client = await provider.Client.find(String(details.params.client_id));
      res.status(401).send(renderInteractionPage(details, client?.clientName, "口令不正确，请重试。"));
      return;
    }

    await limits.clearLogin(req.ip ?? req.socket.remoteAddress ?? "unknown");
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: SHARED_ACCOUNT_ID, remember: true, amr: ["pwd"] } },
      { mergeWithLastSubmission: false },
    );
  }));

  router.post("/oauth/interaction/:uid/confirm", formBody, verifyFormOrigin(config), asyncHandler(async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name !== "consent") throw new Error("Unexpected OAuth interaction prompt");
    const grantId = await grantRequestedScopes(provider, details);
    await provider.interactionFinished(
      req,
      res,
      { consent: details.grantId ? {} : { grantId } },
      { mergeWithLastSubmission: true },
    );
  }));

  router.post("/oauth/interaction/:uid/abort", formBody, verifyFormOrigin(config), asyncHandler(async (req, res) => {
    await provider.interactionDetails(req, res);
    await provider.interactionFinished(
      req,
      res,
      { error: "access_denied", error_description: "Authorization was cancelled" },
      { mergeWithLastSubmission: false },
    );
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof UsageLimitError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      res.status(429).send(renderErrorPage(error.message));
      return;
    }
    logger.error({ err: error }, "OAuth interaction failed");
    res.status(400).send(renderErrorPage("授权会话已失效，请回到 ChatGPT 后重新连接。"));
  });

  return router;
}

async function grantRequestedScopes(provider: Provider, details: InteractionDetails): Promise<string> {
  const accountId = details.session?.accountId;
  if (!accountId) throw new Error("OAuth session has no account");

  let grant: Grant | undefined;
  if (details.grantId) grant = await provider.Grant.find(details.grantId);
  grant ??= new provider.Grant({ accountId, clientId: String(details.params.client_id) });

  const promptDetails = details.prompt.details as {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    missingResourceScopes?: Record<string, string[]>;
  };
  if (promptDetails.missingOIDCScope?.length) grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
  if (promptDetails.missingOIDCClaims?.length) grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  for (const [resource, scopes] of Object.entries(promptDetails.missingResourceScopes ?? {})) {
    grant.addResourceScope(resource, scopes.join(" "));
  }
  return grant.save();
}

function verifyFormOrigin(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    const referer = req.get("referer");
    const valid = origin === config.publicBaseUrl.origin || (!origin && referer?.startsWith(`${config.publicBaseUrl.origin}/`));
    if (!valid) {
      res.status(403).send(renderErrorPage("请求来源校验失败。"));
      return;
    }
    next();
  };
}

function safeEqual(value: string, expected: string): boolean {
  const left = createHash("sha256").update(value).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function renderInteractionPage(details: InteractionDetails, clientName = "ChatGPT", error?: string): string {
  const name = escapeHtml(clientName);
  const uid = encodeURIComponent(details.uid);
  const isLogin = details.prompt.name === "login";
  const title = isLogin ? "连接 WJ 生图" : "确认授权";
  const description = isLogin
    ? `${name} 正在请求连接 WJ 生图服务。请输入服务端配置的共享访问口令。`
    : `${name} 将获得调用 WJ 生图工具的权限，并会消耗服务端配置的 WJ 额度。`;
  const action = isLogin ? `/oauth/interaction/${uid}/login` : `/oauth/interaction/${uid}/confirm`;
  const field = isLogin
    ? '<label for="password">访问口令</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>'
    : '<div class="scope"><strong>授权范围</strong><span>使用 WJ 生成和展示图片</span></div>';
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";

  return pageShell(title, `
    <main>
      <div class="brand">WJ</div>
      <h1>${title}</h1>
      <p>${description}</p>
      ${errorHtml}
      <form method="post" action="${action}">
        ${field}
        <button class="primary" type="submit">${isLogin ? "继续" : "允许"}</button>
      </form>
      <form method="post" action="/oauth/interaction/${uid}/abort">
        <button class="secondary" type="submit">取消</button>
      </form>
      <small>WJ API Key 只保存在服务器端，不会发送给 ChatGPT。</small>
    </main>
  `);
}

function renderErrorPage(message: string): string {
  return pageShell("授权失败", `<main><div class="brand">WJ</div><h1>授权失败</h1><p>${escapeHtml(message)}</p></main>`);
}

function pageShell(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7f6;color:#17211d}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7f6}
    main{width:min(100%,420px);background:#fff;border:1px solid #dce3df;border-radius:8px;padding:32px;box-shadow:0 10px 32px rgba(17,36,27,.08)}
    .brand{width:42px;height:42px;display:grid;place-items:center;background:#163f31;color:#fff;border-radius:8px;font-weight:800}
    h1{font-size:24px;line-height:1.25;margin:20px 0 10px;letter-spacing:0}p{color:#53615b;line-height:1.6;margin:0 0 22px}
    form{margin:0 0 10px}label{display:block;font-size:14px;font-weight:650;margin-bottom:8px}input{width:100%;height:44px;border:1px solid #aab8b1;border-radius:6px;padding:0 12px;font:inherit;margin-bottom:14px;background:#fff;color:#17211d}
    button{width:100%;height:44px;border-radius:6px;font:inherit;font-weight:700;cursor:pointer}.primary{border:0;background:#176b4d;color:#fff}.secondary{border:1px solid #cad3ce;background:#fff;color:#314139}
    .scope{border:1px solid #dce3df;background:#f7faf8;border-radius:6px;padding:14px;margin-bottom:14px;display:grid;gap:4px}.scope span,small{color:#66736d;font-size:13px;line-height:1.5}.error{color:#9b1c1c;background:#fff2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;font-size:14px}.error+form{margin-top:14px}
    @media(prefers-color-scheme:dark){:root,body{background:#121714;color:#edf4f0}main{background:#1b231f;border-color:#344039}p,.scope span,small{color:#aebbb4}input,.secondary{background:#121714;color:#edf4f0;border-color:#46534c}.scope{background:#151c18;border-color:#344039}}
  </style></head><body>${body}</body></html>`;
}

function setAuthorizationPageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

export const WJ_IMAGE_SCOPE = REQUIRED_SCOPE;

import { randomBytes } from "node:crypto";

import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.use = "sig";
jwk.alg = "ES256";
jwk.kid = randomBytes(12).toString("base64url");

const cookieKeys = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];

process.stdout.write([
  `OAUTH_COOKIE_KEYS=${cookieKeys.join(",")}`,
  `OAUTH_JWKS='${JSON.stringify({ keys: [jwk] })}'`,
  "",
].join("\n"));

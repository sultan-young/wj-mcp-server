import type { Adapter, AdapterConstructor, AdapterPayload } from "oidc-provider";

import type { RedisClient } from "../redis.js";

const grantableModels = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
  "PreAuthorizedCode",
]);

export function createOidcRedisAdapter(client: RedisClient, maxTtlSeconds: number): AdapterConstructor {
  return class RedisAdapter implements Adapter {
    constructor(private readonly model: string) {}

    private itemKey(id: string) {
      return `wj:mcp:oidc:item:${this.model}:${id}`;
    }

    private uidKey(uid: string) {
      return `wj:mcp:oidc:uid:${uid}`;
    }

    private userCodeKey(userCode: string) {
      return `wj:mcp:oidc:user-code:${userCode}`;
    }

    private grantKey(grantId: string) {
      return `wj:mcp:oidc:grant:${grantId}`;
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const key = this.itemKey(id);
      const ttl = typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? Math.max(1, Math.floor(expiresIn))
        : undefined;
      const operations: Promise<unknown>[] = [
        ttl
          ? client.set(key, JSON.stringify(payload), { EX: ttl })
          : client.set(key, JSON.stringify(payload)),
      ];

      if (this.model === "Session" && payload.uid) {
        operations.push(ttl ? client.set(this.uidKey(payload.uid), id, { EX: ttl }) : client.set(this.uidKey(payload.uid), id));
      }
      if (payload.userCode) {
        operations.push(ttl ? client.set(this.userCodeKey(payload.userCode), id, { EX: ttl }) : client.set(this.userCodeKey(payload.userCode), id));
      }
      if (grantableModels.has(this.model) && payload.grantId) {
        const grantKey = this.grantKey(payload.grantId);
        operations.push(client.sAdd(grantKey, key));
        operations.push(client.expire(grantKey, maxTtlSeconds));
      }

      await Promise.all(operations);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      const value = await client.get(this.itemKey(id));
      return value ? (JSON.parse(value) as AdapterPayload) : undefined;
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      const id = await client.get(this.userCodeKey(userCode));
      return id ? this.find(id) : undefined;
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const id = await client.get(this.uidKey(uid));
      return id ? this.find(id) : undefined;
    }

    async consume(id: string): Promise<void> {
      const key = this.itemKey(id);
      const value = await client.get(key);
      if (!value) return;
      const payload = JSON.parse(value) as AdapterPayload;
      payload.consumed = Math.floor(Date.now() / 1000);
      await client.set(key, JSON.stringify(payload), { KEEPTTL: true });
    }

    async destroy(id: string): Promise<void> {
      const key = this.itemKey(id);
      const payload = await this.find(id);
      await client.del(key);
      if (!payload) return;

      if (payload.uid && (await client.get(this.uidKey(payload.uid))) === id) {
        await client.del(this.uidKey(payload.uid));
      }
      if (payload.userCode && (await client.get(this.userCodeKey(payload.userCode))) === id) {
        await client.del(this.userCodeKey(payload.userCode));
      }
      if (grantableModels.has(this.model) && payload.grantId) {
        await client.sRem(this.grantKey(payload.grantId), key);
      }
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const grantKey = this.grantKey(grantId);
      const keys = await client.sMembers(grantKey);
      if (keys.length) await client.del(keys);
      await client.del(grantKey);
    }
  };
}

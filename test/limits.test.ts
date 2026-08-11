import { describe, expect, it } from "vitest";

import { UsageLimits } from "../src/limits.js";
import type { RedisClient } from "../src/redis.js";
import { testConfig } from "./helpers.js";

describe("UsageLimits", () => {
  it("uses the node-redis eval signature and stores registration counters", async () => {
    const redis = new NodeRedisLike();
    const limits = new UsageLimits(redis as unknown as RedisClient, testConfig());

    await expect(limits.consumeRegistration("203.0.113.10")).resolves.toBeUndefined();
    expect(redis.values.get("wj:mcp:limit:registration:203.0.113.10")).toBe(1);
  });

  it("does not report Redis failures as rate-limit responses", async () => {
    const redis = new NodeRedisLike(new Error("redis unavailable"));
    const limits = new UsageLimits(redis as unknown as RedisClient, testConfig());

    await expect(limits.consumeRegistration("203.0.113.11")).rejects.toThrow("redis unavailable");
  });
});

class NodeRedisLike {
  readonly isReady = true;
  readonly values = new Map<string, number>();

  constructor(private readonly failure?: Error) {}

  multi(): Record<string, never> {
    return {};
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<[number, number]> {
    if (this.failure) throw this.failure;
    const key = options.keys[0];
    const increment = options.arguments[0];
    const durationSeconds = options.arguments[1];
    if (!key || !increment || !durationSeconds) throw new Error("invalid eval arguments");
    const consumed = (this.values.get(key) ?? 0) + Number(increment);
    this.values.set(key, consumed);
    return [consumed, Number(durationSeconds) * 1000];
  }
}

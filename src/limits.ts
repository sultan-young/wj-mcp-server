import { RateLimiterRedis, type RateLimiterRes } from "rate-limiter-flexible";

import type { AppConfig } from "./config.js";
import type { RedisClient } from "./redis.js";

export class UsageLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "UsageLimitError";
  }
}

export class UsageLimits {
  private readonly loginLimiter: RateLimiterRedis;
  private readonly registrationLimiter: RateLimiterRedis;

  constructor(client: RedisClient, config: AppConfig) {
    const storeClient = client as unknown as ConstructorParameters<typeof RateLimiterRedis>[0]["storeClient"];
    this.loginLimiter = new RateLimiterRedis({
      storeClient,
      useRedisPackage: true,
      rejectIfRedisNotReady: true,
      keyPrefix: "wj:mcp:limit:login",
      points: config.LOGIN_ATTEMPTS_PER_15_MINUTES,
      duration: 900,
      blockDuration: 900,
    });
    this.registrationLimiter = new RateLimiterRedis({
      storeClient,
      useRedisPackage: true,
      rejectIfRedisNotReady: true,
      keyPrefix: "wj:mcp:limit:registration",
      points: config.REGISTRATIONS_PER_HOUR,
      duration: 3600,
      blockDuration: 3600,
    });
  }

  async consumeLogin(ip: string): Promise<void> {
    try {
      await this.loginLimiter.consume(ip);
    } catch (error) {
      const result = getRateLimitResult(error);
      const retryAfterSeconds = Math.max(1, Math.ceil((result.msBeforeNext ?? 900_000) / 1000));
      throw new UsageLimitError("Too many authorization attempts. Try again later.", retryAfterSeconds);
    }
  }

  async clearLogin(ip: string): Promise<void> {
    await this.loginLimiter.delete(ip);
  }

  async consumeRegistration(ip: string): Promise<void> {
    try {
      await this.registrationLimiter.consume(ip);
    } catch (error) {
      const result = getRateLimitResult(error);
      const retryAfterSeconds = Math.max(1, Math.ceil((result.msBeforeNext ?? 3_600_000) / 1000));
      throw new UsageLimitError("Too many OAuth client registrations. Try again later.", retryAfterSeconds);
    }
  }
}

function getRateLimitResult(error: unknown): RateLimiterRes {
  if (error instanceof Error) throw error;
  if (typeof error !== "object" || error === null || typeof (error as RateLimiterRes).msBeforeNext !== "number") {
    throw error;
  }
  return error as RateLimiterRes;
}

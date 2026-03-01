import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import { RedisProviderRateLimiter } from "./redisProviderRateLimiter";

class InMemoryRedis {
  private readonly values = new Map<string, number>();
  private readonly expires = new Map<string, number>();

  /**
   * Increments a numeric key for budget accounting tests while preserving basic Redis INCR semantics.
   */
  async incr(key: string): Promise<number> {
    this.expireIfNeeded(key);
    const value = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }

  /**
   * Stores TTL metadata for keys so daily budget tests can verify reset behavior.
   */
  async pexpire(key: string, ttlMs: number): Promise<number> {
    this.expires.set(key, Date.now() + ttlMs);
    return 1;
  }

  /**
   * Returns zero wait in tests because interval pacing behavior is covered by integration tests.
   */
  async eval(): Promise<number> {
    return 0;
  }

  private expireIfNeeded(key: string): void {
    const deadline = this.expires.get(key);
    if (typeof deadline === "number" && deadline <= Date.now()) {
      this.values.delete(key);
      this.expires.delete(key);
    }
  }
}

describe("RedisProviderRateLimiter", () => {
  it("enforces configured daily request cap", async () => {
    const redis = new InMemoryRedis();
    const limiter = new RedisProviderRateLimiter(
      { host: "localhost", port: 6379 },
      {},
      { alphavantage: 2 },
      "test-rate-limit",
      redis as unknown as Redis,
      () => new Date("2026-03-01T10:00:00.000Z"),
    );

    const first = await limiter.tryConsumeDailyBudget("alphavantage");
    const second = await limiter.tryConsumeDailyBudget("alphavantage");
    const third = await limiter.tryConsumeDailyBudget("alphavantage");

    expect(first.allowed).toBeTrue();
    expect(second.allowed).toBeTrue();
    expect(third.allowed).toBeFalse();
    expect(third.remaining).toBe(0);
  });

  it("resets budget on the next UTC day", async () => {
    const redis = new InMemoryRedis();
    let now = new Date("2026-03-01T23:59:00.000Z");
    const limiter = new RedisProviderRateLimiter(
      { host: "localhost", port: 6379 },
      {},
      { alphavantage: 1 },
      "test-rate-limit",
      redis as unknown as Redis,
      () => now,
    );

    const dayOneFirst = await limiter.tryConsumeDailyBudget("alphavantage");
    const dayOneSecond = await limiter.tryConsumeDailyBudget("alphavantage");
    now = new Date("2026-03-02T00:00:01.000Z");
    const dayTwoFirst = await limiter.tryConsumeDailyBudget("alphavantage");

    expect(dayOneFirst.allowed).toBeTrue();
    expect(dayOneSecond.allowed).toBeFalse();
    expect(dayTwoFirst.allowed).toBeTrue();
  });
});

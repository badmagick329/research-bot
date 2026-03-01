import Redis, { type RedisOptions } from "ioredis";
import type {
  ProviderRateLimitKey,
  ProviderRateLimiterPort,
} from "../../core/ports/outboundPorts";

const reserveSlotScript = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local ok = redis.call('SET', key, '1', 'NX', 'PX', ttl)
if ok then
  return 0
end
local pttl = redis.call('PTTL', key)
if pttl < 0 then
  return ttl
end
return pttl
`;

/**
 * Coordinates provider request pacing across workers via Redis so free-tier limits are respected globally.
 */
export class RedisProviderRateLimiter implements ProviderRateLimiterPort {
  private readonly redis: Redis;

  constructor(
    connection: RedisOptions,
    private readonly minIntervalByProvider: Partial<
      Record<ProviderRateLimitKey, number>
    >,
    private readonly dailyRequestCapByProvider: Partial<
      Record<ProviderRateLimitKey, number>
    > = {},
    private readonly keyPrefix = "research-bot:provider-rate-limit",
    redisClient?: Redis,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {
    this.redis = redisClient ?? new Redis(connection);
  }

  /**
   * Waits until the provider's next slot is available to prevent burst traffic from parallel workers.
   */
  async waitForSlot(provider: ProviderRateLimitKey): Promise<void> {
    const minIntervalMs = this.minIntervalByProvider[provider] ?? 0;
    if (minIntervalMs <= 0) {
      return;
    }

    const redisKey = `${this.keyPrefix}:${provider}`;
    while (true) {
      const waitMs = await this.reserveSlot(redisKey, minIntervalMs);
      if (waitMs <= 0) {
        return;
      }

      await this.delay(waitMs);
    }
  }

  /**
   * Reserves one request from the provider's UTC-day budget so callers can fail fast before spending network retries.
   */
  async tryConsumeDailyBudget(
    provider: ProviderRateLimitKey,
  ): Promise<{ allowed: boolean; remaining?: number }> {
    const cap = this.dailyRequestCapByProvider[provider];
    if (!cap || cap <= 0) {
      return { allowed: true };
    }

    const now = this.nowProvider();
    const dateBucket = now.toISOString().slice(0, 10);
    const budgetKey = `${this.keyPrefix}:${provider}:daily:${dateBucket}`;
    const ttlMs = this.msUntilNextUtcDay(now);
    const counter = await this.redis.incr(budgetKey);
    if (counter === 1) {
      await this.redis.pexpire(budgetKey, ttlMs);
    }

    if (counter > cap) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: Math.max(0, cap - counter) };
  }

  private async reserveSlot(
    key: string,
    minIntervalMs: number,
  ): Promise<number> {
    const result = await this.redis.eval(
      reserveSlotScript,
      1,
      key,
      minIntervalMs,
    );
    if (typeof result === "number") {
      return result;
    }

    const parsed = Number(result);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return minIntervalMs;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(1, ms));
    });
  }

  private msUntilNextUtcDay(now: Date): number {
    const next = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
    return Math.max(1, next - now.getTime());
  }
}

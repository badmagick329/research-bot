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
    private readonly minIntervalByProvider: Record<
      ProviderRateLimitKey,
      number
    >,
    private readonly keyPrefix = "research-bot:provider-rate-limit",
  ) {
    this.redis = new Redis(connection);
  }

  /**
   * Waits until the provider's next slot is available to prevent burst traffic from parallel workers.
   */
  async waitForSlot(provider: ProviderRateLimitKey): Promise<void> {
    const minIntervalMs = this.minIntervalByProvider[provider];
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
}

import { describe, expect, it } from "bun:test";
import { JobScheduler, Queue } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { JobPayload } from "../../core/ports/outboundPorts";
import {
  defaultJobOptions,
  BullMqQueue,
  createStageWorker,
} from "./bullMqQueue";
import { queueNames } from "./queues";

const redisConfigFromUrl = (url: string): RedisOptions => {
  const parsed = new URL(url);
  const dbValue = parsed.pathname.replace("/", "").trim();
  const parsedDb = Number.parseInt(dbValue, 10);

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(parsedDb) ? parsedDb : 0,
  };
};

describe("BullMqQueue retry integration", () => {
  it("retries failed stage processing up to configured attempts", async () => {
    const redis = {
      ...redisConfigFromUrl(process.env.REDIS_URL ?? "redis://localhost:6379"),
      db: 15,
    } satisfies RedisOptions;

    const queue = new BullMqQueue(redis);
    const ingestQueue = new Queue<JobPayload>(queueNames.ingest, {
      connection: redis,
    });
    const scheduler = new JobScheduler(queueNames.ingest, {
      connection: redis,
    });

    let attempts = 0;
    let resolveCompleted: (() => void) | undefined;

    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });

    const worker = createStageWorker("ingest", redis, 1, async () => {
      attempts += 1;

      if (attempts < defaultJobOptions.attempts) {
        throw new Error(`simulated ingest failure on attempt ${attempts}`);
      }

      resolveCompleted?.();
    });

    const payload: JobPayload = {
      runId: `run-retry-${crypto.randomUUID()}`,
      taskId: `task-retry-${crypto.randomUUID()}`,
      symbol: "AAPL",
      idempotencyKey: `retry-integration-${crypto.randomUUID()}`,
      requestedAt: new Date().toISOString(),
    };

    try {
      await ingestQueue.waitUntilReady();
      await scheduler.waitUntilReady();
      await worker.waitUntilReady();
      await ingestQueue.drain(true);
      await ingestQueue.resume();
      await queue.enqueue("ingest", payload);

      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("retry integration test timed out")),
            25_000,
          );
        }),
      ]);

      expect(attempts).toBe(defaultJobOptions.attempts);
    } finally {
      await worker.close();
      await scheduler.close();
      await queue.close();
      await ingestQueue.close();
    }
  }, 30_000);
});

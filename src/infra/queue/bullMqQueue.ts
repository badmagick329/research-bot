import { Queue, type WorkerOptions, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { JobStage } from "../../core/entities/research";
import type { JobPayload, QueuePort } from "../../core/ports/outboundPorts";
import { queueNames } from "./queues";

export type QueueStageCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

export type QueueCountsSnapshot = Record<JobStage, QueueStageCounts>;

const QUEUE_RETRIES = 2;

export const defaultJobOptions = {
  attempts: QUEUE_RETRIES + 1,
  removeOnComplete: 250,
  backoff: {
    type: "exponential",
    delay: 1_000,
  },
} as const;

/**
 * Wraps BullMQ so application code depends on queue intent rather than queue vendor details.
 */
export class BullMqQueue implements QueuePort {
  private readonly queues = new Map<JobStage, Queue<JobPayload>>();

  constructor(private readonly connection: RedisOptions) {
    (Object.keys(queueNames) as JobStage[]).forEach((stage) => {
      this.queues.set(
        stage,
        new Queue<JobPayload>(queueNames[stage], {
          connection: this.connection,
          defaultJobOptions,
        }),
      );
    });
  }

  /**
   * Enforces stage-specific routing and idempotent job identity at one infrastructure boundary.
   * BullMQ rejects custom job ids containing colon because colon is reserved in its Redis key format.
   */
  async enqueue(stage: JobStage, payload: JobPayload): Promise<void> {
    const queue = this.queues.get(stage);
    if (!queue) {
      throw new Error(`Queue not configured for stage ${stage}`);
    }

    await queue.add(payload.idempotencyKey, payload, {
      jobId: payload.idempotencyKey,
    });
  }

  /**
   * Provides explicit shutdown control to reduce dangling Redis connections during process teardown.
   */
  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
  }

  /**
   * Collects per-stage queue counters so status commands can expose current backlog and failure pressure.
   */
  async getQueueCounts(): Promise<QueueCountsSnapshot> {
    const entries = await Promise.all(
      (Object.keys(queueNames) as JobStage[]).map(async (stage) => {
        const queue = this.queues.get(stage);
        if (!queue) {
          throw new Error(`Queue not configured for stage ${stage}`);
        }

        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
          "paused",
        );

        return [
          stage,
          {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
            paused: counts.paused ?? 0,
          },
        ] as const;
      }),
    );

    return Object.fromEntries(entries) as QueueCountsSnapshot;
  }
}

/**
 * Standardizes worker creation so stage consumers share retry and concurrency conventions.
 */
export const createStageWorker = (
  stage: JobStage,
  connection: RedisOptions,
  concurrency: number,
  processor: (payload: JobPayload) => Promise<void>,
) => {
  const options: WorkerOptions = {
    connection,
    concurrency,
  };

  return new Worker<JobPayload>(
    queueNames[stage],
    async (job) => {
      await processor(job.data);
    },
    options,
  );
};

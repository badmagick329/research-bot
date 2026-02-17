import { Queue, type WorkerOptions, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { JobStage } from "../../core/entities/research";
import type { JobPayload, QueuePort } from "../../core/ports/outboundPorts";
import { queueNames } from "./queues";

export const defaultJobOptions = {
  attempts: 3,
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

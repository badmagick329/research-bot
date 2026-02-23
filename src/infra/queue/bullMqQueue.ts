import { Queue, type WorkerOptions, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { QueueCountsResponse } from "../../core/entities/opsConsole";
import type { JobStage } from "../../core/entities/research";
import type {
  JobPayload,
  QueuePort,
  QueueRunReadPort,
  QueueRunState,
  QueueReceiptPort,
} from "../../core/ports/outboundPorts";
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
const RUN_STATE_SCAN_LIMIT = 500;

export const defaultJobOptions = {
  attempts: QUEUE_RETRIES + 1,
  removeOnComplete: 250,
  backoff: {
    type: "exponential",
    delay: 1_000,
  },
} as const;

type QueueJobLifecycleState =
  | "active"
  | "waiting"
  | "delayed"
  | "completed"
  | "failed";

type QueueStageRuntimeStatus =
  | "not_started"
  | "queued"
  | "running"
  | "success"
  | "failed";

type StageObservation = {
  stage: JobStage;
  payload: JobPayload;
  state: QueueJobLifecycleState;
  updatedAt: Date;
};

/**
 * Wraps BullMQ so application code depends on queue intent rather than queue vendor details.
 */
export class BullMqQueue
  implements QueuePort, QueueReceiptPort, QueueRunReadPort
{
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
    await this.enqueueWithReceipt(stage, payload);
  }

  /**
   * Returns queue acknowledgement metadata so API callers can correlate accepted requests to queue state.
   */
  async enqueueWithReceipt(
    stage: JobStage,
    payload: JobPayload,
  ): Promise<{
    runId: string;
    taskId: string;
    requestedAt: string;
    enqueuedAt: string;
    deduped: boolean;
  }> {
    const queue = this.queues.get(stage);
    if (!queue) {
      throw new Error(`Queue not configured for stage ${stage}`);
    }

    const job = await queue.add(payload.idempotencyKey, payload, {
      jobId: payload.idempotencyKey,
    });

    const resolvedPayload = job.data;
    const deduped =
      resolvedPayload.runId !== payload.runId ||
      resolvedPayload.taskId !== payload.taskId;

    return {
      runId: resolvedPayload.runId,
      taskId: resolvedPayload.taskId,
      requestedAt: resolvedPayload.requestedAt,
      enqueuedAt: new Date(job.timestamp).toISOString(),
      deduped,
    };
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

  /**
   * Samples queue counters with per-stage timestamps to support contract-stable operational polling responses.
   */
  async getQueueCountsSampled(): Promise<QueueCountsResponse> {
    const snapshot = await this.getQueueCounts();

    return {
      items: (Object.keys(queueNames) as JobStage[]).map((stage) => ({
        stage,
        sampledAt: new Date().toISOString(),
        counts: snapshot[stage],
      })),
    };
  }

  /**
   * Projects queue-backed run status so monitor views can show pre-snapshot lifecycle progress.
   */
  async getRunState(runId: string): Promise<QueueRunState | null> {
    const observations = await this.collectRunObservations(runId);
    if (observations.length === 0) {
      return null;
    }

    const latestObservation = observations
      .slice()
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )[0];

    if (!latestObservation) {
      return null;
    }

    const stageStatusByStage = new Map<JobStage, QueueStageRuntimeStatus>();

    for (const stage of Object.keys(queueNames) as JobStage[]) {
      stageStatusByStage.set(stage, "not_started");
    }

    for (const observation of observations) {
      const current =
        stageStatusByStage.get(observation.stage) ?? "not_started";
      const candidate = this.mapLifecycleStateToStageStatus(observation.state);
      if (
        this.stageStatusPriority(candidate) >= this.stageStatusPriority(current)
      ) {
        stageStatusByStage.set(observation.stage, candidate);
      }
    }

    const stages = (Object.keys(queueNames) as JobStage[]).map((stage) => ({
      stage,
      status: stageStatusByStage.get(stage) ?? "not_started",
    }));

    const hasFailure = stages.some((stage) => stage.status === "failed");
    const runStatus: QueueRunState["status"] = hasFailure
      ? "failed"
      : "running";
    const identity = latestObservation.payload.resolvedIdentity;

    return {
      runId: latestObservation.payload.runId,
      taskId: latestObservation.payload.taskId,
      symbol: latestObservation.payload.symbol,
      requestedAt: latestObservation.payload.requestedAt,
      requestedSymbol:
        identity?.requestedSymbol ?? latestObservation.payload.symbol,
      canonicalSymbol:
        identity?.canonicalSymbol ?? latestObservation.payload.symbol,
      status: runStatus,
      stages,
      identity,
      updatedAt: latestObservation.updatedAt.toISOString(),
    };
  }

  /**
   * Projects the most recent queue-backed run for a symbol so list views can include in-flight activity.
   */
  async getLatestRunStateBySymbol(
    symbol: string,
  ): Promise<QueueRunState | null> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) {
      return null;
    }

    const observations = await this.collectSymbolObservations(normalized);
    if (observations.length === 0) {
      return null;
    }

    const latest = observations
      .slice()
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )[0];

    if (!latest) {
      return null;
    }

    return this.getRunState(latest.payload.runId);
  }

  /**
   * Collects run-specific job observations across all queue stages to derive a consistent status projection.
   */
  private async collectRunObservations(
    runId: string,
  ): Promise<StageObservation[]> {
    const lifecycleStates: QueueJobLifecycleState[] = [
      "active",
      "waiting",
      "delayed",
      "completed",
      "failed",
    ];

    const observationsByStage = await Promise.all(
      (Object.keys(queueNames) as JobStage[]).map(async (stage) => {
        const queue = this.queues.get(stage);
        if (!queue) {
          throw new Error(`Queue not configured for stage ${stage}`);
        }

        const jobs = await queue.getJobs(
          lifecycleStates,
          0,
          RUN_STATE_SCAN_LIMIT,
          false,
        );
        return jobs
          .filter((job) => job.data.runId === runId)
          .map(
            (job) =>
              ({
                stage,
                payload: job.data,
                state: (job.finishedOn
                  ? job.failedReason
                    ? "failed"
                    : "completed"
                  : job.processedOn
                    ? "active"
                    : job.opts.delay && job.opts.delay > 0
                      ? "delayed"
                      : "waiting") as QueueJobLifecycleState,
                updatedAt: new Date(
                  job.finishedOn ??
                    job.processedOn ??
                    job.timestamp ??
                    Date.now(),
                ),
              }) satisfies StageObservation,
          );
      }),
    );

    return observationsByStage.flat();
  }

  /**
   * Collects queue observations for a symbol across stages so list views can locate the newest in-flight run.
   */
  private async collectSymbolObservations(
    symbol: string,
  ): Promise<StageObservation[]> {
    const lifecycleStates: QueueJobLifecycleState[] = [
      "active",
      "waiting",
      "delayed",
      "completed",
      "failed",
    ];

    const observationsByStage = await Promise.all(
      (Object.keys(queueNames) as JobStage[]).map(async (stage) => {
        const queue = this.queues.get(stage);
        if (!queue) {
          throw new Error(`Queue not configured for stage ${stage}`);
        }

        const jobs = await queue.getJobs(
          lifecycleStates,
          0,
          RUN_STATE_SCAN_LIMIT,
          false,
        );

        return jobs
          .filter((job) => job.data.symbol.toUpperCase() === symbol)
          .map(
            (job) =>
              ({
                stage,
                payload: job.data,
                state: (job.finishedOn
                  ? job.failedReason
                    ? "failed"
                    : "completed"
                  : job.processedOn
                    ? "active"
                    : job.opts.delay && job.opts.delay > 0
                      ? "delayed"
                      : "waiting") as QueueJobLifecycleState,
                updatedAt: new Date(
                  job.finishedOn ??
                    job.processedOn ??
                    job.timestamp ??
                    Date.now(),
                ),
              }) satisfies StageObservation,
          );
      }),
    );

    return observationsByStage.flat();
  }

  /**
   * Maps BullMQ lifecycle states into route-level stage statuses for contract-stable monitor rendering.
   */
  private mapLifecycleStateToStageStatus(
    state: QueueJobLifecycleState,
  ): QueueStageRuntimeStatus {
    switch (state) {
      case "active":
        return "running";
      case "waiting":
      case "delayed":
        return "queued";
      case "completed":
        return "success";
      case "failed":
        return "failed";
      default:
        return "not_started";
    }
  }

  /**
   * Provides deterministic ordering for stage status selection when multiple observations exist.
   */
  private stageStatusPriority(status: QueueStageRuntimeStatus): number {
    switch (status) {
      case "failed":
        return 5;
      case "running":
        return 4;
      case "queued":
        return 3;
      case "success":
        return 2;
      default:
        return 1;
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

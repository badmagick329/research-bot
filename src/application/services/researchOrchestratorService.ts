import type { JobStage } from "../../core/entities/research";
import type {
  QueuePort,
  TaskFactoryPort,
} from "../../core/ports/outboundPorts";

/**
 * Owns stage handoff policy so scheduling behavior stays consistent across CLI and worker-triggered flows.
 */
export class ResearchOrchestratorService {
  constructor(
    private readonly queue: QueuePort,
    private readonly taskFactory: TaskFactoryPort,
  ) {}

  /**
   * Enqueues symbol work through one policy point while allowing explicit dedupe bypass for operator reruns.
   */
  async enqueueForSymbol(
    symbol: string,
    stage: JobStage = "ingest",
    force = false,
  ): Promise<void> {
    const task = this.taskFactory.create(symbol, stage);
    const idempotencyKey = force
      ? `${task.idempotencyKey}:force:${task.id}`
      : task.idempotencyKey;

    await this.queue.enqueue(stage, {
      taskId: task.id,
      symbol: task.symbol,
      idempotencyKey,
      requestedAt: task.requestedAt.toISOString(),
    });
  }
}

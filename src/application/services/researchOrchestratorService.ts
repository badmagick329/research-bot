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
   * Enqueues symbol work through a single policy point to preserve idempotency semantics.
   */
  async enqueueForSymbol(
    symbol: string,
    stage: JobStage = "ingest",
  ): Promise<void> {
    const task = this.taskFactory.create(symbol, stage);
    await this.queue.enqueue(stage, {
      taskId: task.id,
      symbol: task.symbol,
      idempotencyKey: task.idempotencyKey,
      requestedAt: task.requestedAt.toISOString(),
    });
  }
}

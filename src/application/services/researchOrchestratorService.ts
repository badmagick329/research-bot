import type { JobStage } from "../../core/entities/research";
import type { CompanyResolverPort } from "../../core/ports/inboundPorts";
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
    private readonly companyResolver: CompanyResolverPort,
  ) {}

  /**
   * Enqueues symbol work through one policy point while allowing explicit dedupe bypass for operator reruns.
   */
  async enqueueForSymbol(
    symbol: string,
    stage: JobStage = "ingest",
    force = false,
  ): Promise<void> {
    const resolution = await this.companyResolver.resolveCompany({
      symbolOrName: symbol,
    });

    if (resolution.isErr()) {
      throw new Error(
        `Company resolution failed for '${symbol}': ${resolution.error.message}`,
      );
    }

    const identity = resolution.value.identity;
    const task = this.taskFactory.create(identity.canonicalSymbol, stage);
    const idempotencyKey = force
      ? `${task.idempotencyKey}-force-${task.id}`
      : task.idempotencyKey;

    await this.queue.enqueue(stage, {
      runId: task.runId,
      taskId: task.id,
      symbol: task.symbol,
      idempotencyKey,
      requestedAt: task.requestedAt.toISOString(),
      resolvedIdentity: identity,
    });
  }
}

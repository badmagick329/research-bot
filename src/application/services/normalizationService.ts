import type {
  JobPayload,
  DocumentRepositoryPort,
  QueuePort,
  LlmPort,
} from "../../core/ports/outboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import type { SnapshotStageDiagnostics } from "../../core/entities/research";

/**
 * Creates a normalization checkpoint so embedding and synthesis consume consistent context framing.
 */
export class NormalizationService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly llm: LlmPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Captures normalization degradation details so synthesis can explicitly report quality gaps.
   */
  private withStageIssue(
    payload: JobPayload,
    issue: SnapshotStageDiagnostics,
  ): JobPayload {
    return {
      ...payload,
      stageIssues: [...(payload.stageIssues ?? []), issue],
    };
  }

  /**
   * Converts LLM boundary failures into deterministic stage diagnostics for downstream reporting.
   */
  private toStageIssue(error: AppBoundaryError): SnapshotStageDiagnostics {
    return {
      stage: "normalize",
      status: "degraded",
      reason: `Normalization degraded due to ${error.provider}: ${error.message}`,
      provider: error.provider,
      code: error.code,
      retryable: error.retryable,
    };
  }

  /**
   * Produces a stable intermediate interpretation before expensive embedding and final synthesis steps.
   */
  async run(payload: JobPayload): Promise<void> {
    const docs = await this.documentRepo.listBySymbol(
      payload.symbol,
      30,
      payload.runId,
    );
    if (docs.length === 0) {
      await this.queue.enqueue("synthesize", payload);
      return;
    }

    const top = docs
      .slice(0, 3)
      .map((doc) => `${doc.title}\n${doc.content.slice(0, 200)}`)
      .join("\n\n");
    const summaryResult = await this.llm.summarize(
      `Normalize and tag these items for investing context:\n${top}`,
    );

    if (summaryResult.isErr()) {
      await this.queue.enqueue(
        "embed",
        this.withStageIssue(payload, this.toStageIssue(summaryResult.error)),
      );
      return;
    }

    await this.queue.enqueue("embed", payload);
  }
}

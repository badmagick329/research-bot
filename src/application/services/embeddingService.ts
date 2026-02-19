import type {
  JobPayload,
  DocumentRepositoryPort,
  EmbeddingPort,
  EmbeddingRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import type { SnapshotStageDiagnostics } from "../../core/entities/research";

/**
 * Separates vector generation from ingestion so embedding failures do not block upstream data capture.
 */
export class EmbeddingService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly embeddingPort: EmbeddingPort,
    private readonly embeddingRepo: EmbeddingRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Accumulates embedding-stage degradation details so snapshot output can clearly explain quality impacts.
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
   * Converts embedding boundary errors into consistent stage issue diagnostics.
   */
  private toAdapterIssue(error: AppBoundaryError): SnapshotStageDiagnostics {
    return {
      stage: "embed",
      status: "degraded",
      reason: `Embedding degraded due to ${error.provider}: ${error.message}`,
      provider: error.provider,
      code: error.code,
      retryable: error.retryable,
    };
  }

  /**
   * Advances research jobs into synthesis with persisted vectors for later semantic retrieval.
   */
  async run(payload: JobPayload): Promise<void> {
    const docs = await this.documentRepo.listBySymbol(
      payload.symbol,
      20,
      payload.runId,
    );
    if (docs.length === 0) {
      await this.queue.enqueue("synthesize", payload);
      return;
    }

    const vectorsResult = await this.embeddingPort.embedTexts(
      docs.map((doc) => `${doc.title}\n${doc.content.slice(0, 1_000)}`),
    );

    if (vectorsResult.isErr()) {
      await this.queue.enqueue(
        "synthesize",
        this.withStageIssue(payload, this.toAdapterIssue(vectorsResult.error)),
      );
      return;
    }

    const vectors = vectorsResult.value;
    let nextPayload = payload;

    if (vectors.length !== docs.length) {
      nextPayload = this.withStageIssue(payload, {
        stage: "embed",
        status: "degraded",
        reason: `Embedding returned ${vectors.length} vectors for ${docs.length} documents. Persisted the available subset.`,
        provider: "embedding",
        code: "dimension_mismatch",
        retryable: false,
      });
    }

    const persistCount = Math.min(docs.length, vectors.length);

    for (let index = 0; index < persistCount; index += 1) {
      const doc = docs[index];
      const vector = vectors[index];
      if (!doc || !vector) continue;
      await this.embeddingRepo.upsertForDocument(
        doc.id,
        payload.symbol,
        payload.runId,
        payload.taskId,
        vector,
        doc.content.slice(0, 4_000),
      );
    }

    await this.queue.enqueue("synthesize", nextPayload);
  }
}

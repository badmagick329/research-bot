import type {
  JobPayload,
  DocumentRepositoryPort,
  EmbeddingPort,
  EmbeddingRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";
import {
  appendStageIssue,
  toBoundaryStageIssue,
} from "./shared/stageIssue";

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
        appendStageIssue(
          payload,
          toBoundaryStageIssue({
            stage: "embed",
            summary: "Embedding degraded",
            error: vectorsResult.error,
          }),
        ),
      );
      return;
    }

    const vectors = vectorsResult.value;
    let nextPayload = payload;

    if (vectors.length !== docs.length) {
      nextPayload = appendStageIssue(payload, {
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

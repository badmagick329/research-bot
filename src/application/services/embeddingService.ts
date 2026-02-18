import type {
  JobPayload,
  DocumentRepositoryPort,
  EmbeddingPort,
  EmbeddingRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

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

    const vectors = await this.embeddingPort.embedTexts(
      docs.map((doc) => `${doc.title}\n${doc.content.slice(0, 1_000)}`),
    );

    if (vectors.length !== docs.length) {
      throw new Error(
        `Embedding result count mismatch. Expected ${docs.length}, got ${vectors.length}.`,
      );
    }

    for (let index = 0; index < docs.length; index += 1) {
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

    await this.queue.enqueue("synthesize", payload);
  }
}

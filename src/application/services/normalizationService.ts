import type {
  JobPayload,
  DocumentRepositoryPort,
  QueuePort,
  LlmPort,
} from "../../core/ports/outboundPorts";

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
   * Produces a stable intermediate interpretation before expensive embedding and final synthesis steps.
   */
  async run(payload: JobPayload): Promise<void> {
    const docs = await this.documentRepo.listBySymbol(payload.symbol, 30);
    if (docs.length === 0) {
      await this.queue.enqueue("synthesize", payload);
      return;
    }

    const top = docs
      .slice(0, 3)
      .map((doc) => `${doc.title}\n${doc.content.slice(0, 200)}`)
      .join("\n\n");
    await this.llm.summarize(
      `Normalize and tag these items for investing context:\n${top}`,
    );

    await this.queue.enqueue("embed", payload);
  }
}

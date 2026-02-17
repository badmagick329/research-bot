import type {
  JobPayload,
  DocumentRepositoryPort,
  LlmPort,
  SnapshotRepositoryPort,
  ClockPort,
  IdGeneratorPort,
} from "../../core/ports/outboundPorts";

/**
 * Consolidates evidence into a durable snapshot so decision outputs remain traceable to stored sources.
 */
export class SynthesisService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly snapshotRepo: SnapshotRepositoryPort,
    private readonly llm: LlmPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  /**
   * Removes repeated source references so snapshot citations stay concise and easier to audit.
   */
  private uniqueSources(
    docs: Awaited<ReturnType<DocumentRepositoryPort["listBySymbol"]>>,
  ) {
    const seen = new Set<string>();

    return docs
      .map((doc) => ({
        provider: doc.provider,
        url: doc.url,
        title: doc.title,
      }))
      .filter((source) => {
        const key = `${source.provider}|${source.url ?? ""}|${source.title}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  /**
   * Materializes the latest thesis snapshot to provide a stable read model for downstream consumers.
   */
  async run(payload: JobPayload): Promise<void> {
    const docs = await this.documentRepo.listBySymbol(payload.symbol, 15);
    const sourceLines = docs
      .slice(0, 10)
      .map((doc) => `- ${doc.provider}: ${doc.title}`)
      .join("\n");

    const thesis = await this.llm.synthesize(
      `Create an investing thesis for ${payload.symbol}. Base only on these source headlines:\n${sourceLines}`,
    );

    await this.snapshotRepo.save({
      id: this.ids.next(),
      symbol: payload.symbol,
      horizon: "12m",
      score: 50,
      thesis,
      risks: ["Execution risk", "Macro risk"],
      catalysts: ["Product cycle", "Margin expansion"],
      valuationView: "Neutral until more evidence",
      confidence: docs.length > 0 ? 0.62 : 0.4,
      sources: this.uniqueSources(docs),
      createdAt: this.clock.now(),
    });
  }
}

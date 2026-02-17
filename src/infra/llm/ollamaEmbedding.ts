import type { EmbeddingPort } from "../../core/ports/outboundPorts";

type OllamaEmbedResponse = {
  embeddings?: number[][];
};

/**
 * Isolates embedding vendor behavior so model/backfill strategy can evolve without touching use cases.
 */
export class OllamaEmbedding implements EmbeddingPort {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fallbackDimension: number,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Returns dimension-safe vectors to protect storage and retrieval paths from model output drift.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return texts.map(() => this.zeroVector());
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      const vectors = payload.embeddings ?? [];
      if (vectors.length === 0) {
        return texts.map(() => this.zeroVector());
      }

      return vectors.map((vector) => this.fitVector(vector));
    } catch {
      return texts.map(() => this.zeroVector());
    } finally {
      clearTimeout(timeout);
    }
  }

  private fitVector(vector: number[]): number[] {
    if (vector.length === this.fallbackDimension) return vector;
    if (vector.length > this.fallbackDimension)
      return vector.slice(0, this.fallbackDimension);
    return [
      ...vector,
      ...new Array(this.fallbackDimension - vector.length).fill(0),
    ];
  }

  private zeroVector(): number[] {
    return new Array(this.fallbackDimension).fill(0);
  }
}

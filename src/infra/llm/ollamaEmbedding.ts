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
    private readonly expectedDimension: number,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Returns embeddings only when transport and vector shape are valid to prevent silent quality degradation.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

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
        throw new Error(
          `Ollama embedding request failed with status ${response.status}.`,
        );
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      const vectors = payload.embeddings ?? [];

      if (vectors.length !== texts.length) {
        throw new Error(
          `Ollama embedding response size mismatch. Expected ${texts.length}, got ${vectors.length}.`,
        );
      }

      return vectors.map((vector, index) =>
        this.assertVectorShape(vector, index),
      );
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error("Ollama embedding request failed with an unknown error.");
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Validates embedding shape so storage dimension and model output stay contract-compatible.
   */
  private assertVectorShape(vector: number[], index: number): number[] {
    if (vector.length !== this.expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch for index ${index}. Expected ${this.expectedDimension}, got ${vector.length}.`,
      );
    }

    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error(
        `Embedding vector contains non-finite values at index ${index}.`,
      );
    }

    return vector;
  }
}

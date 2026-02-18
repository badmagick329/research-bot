import type { EmbeddingPort } from "../../core/ports/outboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../http/httpJsonClient";

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
    private readonly httpClient = new HttpJsonClient(),
  ) {}

  /**
   * Returns embeddings only when transport and vector shape are valid to prevent silent quality degradation.
   */
  async embedTexts(
    texts: string[],
  ): Promise<Result<number[][], AppBoundaryError>> {
    if (texts.length === 0) {
      return ok([]);
    }

    const response = await this.httpClient.requestJson<OllamaEmbedResponse>({
      url: `${this.baseUrl}/api/embed`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { model: this.model, input: texts },
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 300,
    });

    if (response.isErr()) {
      return err({
        source: "embedding",
        code: this.mapHttpCode(response.error.httpStatus, response.error.code),
        provider: "ollama",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    const vectors = response.value.embeddings ?? [];

    if (vectors.length !== texts.length) {
      return err({
        source: "embedding",
        code: "malformed_response",
        provider: "ollama",
        message: `Ollama embedding response size mismatch. Expected ${texts.length}, got ${vectors.length}.`,
        retryable: false,
      });
    }

    const normalizedVectors: number[][] = [];
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index];
      if (!vector) {
        return err({
          source: "embedding",
          code: "malformed_response",
          provider: "ollama",
          message: `Ollama embedding vector at index ${index} was missing.`,
          retryable: false,
        });
      }

      const shapeResult = this.assertVectorShape(vector, index);
      if (shapeResult.isErr()) {
        return err(shapeResult.error);
      }
      normalizedVectors.push(shapeResult.value);
    }

    return ok(normalizedVectors);
  }

  /**
   * Validates embedding shape so storage dimension and model output stay contract-compatible.
   */
  private assertVectorShape(
    vector: number[],
    index: number,
  ): Result<number[], AppBoundaryError> {
    if (vector.length !== this.expectedDimension) {
      return err({
        source: "embedding",
        code: "dimension_mismatch",
        provider: "ollama",
        message: `Embedding dimension mismatch for index ${index}. Expected ${this.expectedDimension}, got ${vector.length}.`,
        retryable: false,
      });
    }

    if (vector.some((value) => !Number.isFinite(value))) {
      return err({
        source: "embedding",
        code: "validation_error",
        provider: "ollama",
        message: `Embedding vector contains non-finite values at index ${index}.`,
        retryable: false,
      });
    }

    return ok(vector);
  }

  private mapHttpCode(
    httpStatus: number | undefined,
    errorCode:
      | "timeout"
      | "transport_error"
      | "non_success_status"
      | "invalid_json",
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }

    if (errorCode === "timeout") {
      return "timeout";
    }

    if (errorCode === "invalid_json") {
      return "invalid_json";
    }

    return "provider_error";
  }
}

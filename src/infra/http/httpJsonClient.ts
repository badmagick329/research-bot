import { err, ok, type Result } from "neverthrow";

type HttpMethod = "GET" | "POST";

export type HttpJsonRequest = {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
};

export type HttpClientError = {
  code: "timeout" | "transport_error" | "non_success_status" | "invalid_json";
  message: string;
  httpStatus?: number;
  retryable: boolean;
  cause?: unknown;
};

/**
 * Centralizes HTTP JSON IO so adapters share one timeout/retry/status parsing policy.
 */
export class HttpJsonClient {
  /**
   * Executes JSON requests with bounded retries to avoid duplicated fetch policy across adapters.
   */
  async requestJson<T>(
    request: HttpJsonRequest,
  ): Promise<Result<T, HttpClientError>> {
    const maxAttempts = request.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await this.performRequest<T>(request);
      if (response.isOk()) {
        return response;
      }

      const failure = response.error;
      const hasAttemptsLeft = attempt < maxAttempts;
      if (!failure.retryable || !hasAttemptsLeft) {
        return response;
      }

      await this.delay(request.retryDelayMs * attempt);
    }

    return err({
      code: "transport_error",
      message: "HTTP request exhausted retry attempts.",
      retryable: false,
    });
  }

  private async performRequest<T>(
    request: HttpJsonRequest,
  ): Promise<Result<T, HttpClientError>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;

        return err({
          code: "non_success_status",
          message: `HTTP request failed with status ${response.status}.`,
          httpStatus: response.status,
          retryable,
        });
      }

      try {
        return ok((await response.json()) as T);
      } catch (jsonError) {
        return err({
          code: "invalid_json",
          message: "HTTP response body was not valid JSON.",
          retryable: false,
          cause: jsonError,
        });
      }
    } catch (error) {
      const isTimeoutError =
        error instanceof DOMException && error.name === "AbortError";

      if (isTimeoutError) {
        return err({
          code: "timeout",
          message: "HTTP request timed out.",
          retryable: true,
          cause: error,
        });
      }

      return err({
        code: "transport_error",
        message:
          error instanceof Error ? error.message : "HTTP transport failed.",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

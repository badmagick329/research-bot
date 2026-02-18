import type { LlmPort } from "../../core/ports/outboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../http/httpJsonClient";

type OllamaChatResponse = {
  message?: { content?: string };
};

/**
 * Encapsulates chat-model access so synthesis/normalization stay portable across LLM providers.
 */
export class OllamaLlm implements LlmPort {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 15_000,
    private readonly httpClient = new HttpJsonClient(),
  ) {}

  /**
   * Reuses a single chat path to keep prompt handling policy consistent across intermediate stages.
   */
  async summarize(prompt: string): Promise<Result<string, AppBoundaryError>> {
    return this.chat(prompt);
  }

  /**
   * Keeps final-thesis generation behind the same reliability and fallback policy as other LLM calls.
   */
  async synthesize(prompt: string): Promise<Result<string, AppBoundaryError>> {
    return this.chat(prompt);
  }

  private async chat(
    prompt: string,
  ): Promise<Result<string, AppBoundaryError>> {
    const response = await this.httpClient.requestJson<OllamaChatResponse>({
      url: `${this.baseUrl}/api/chat`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        model: this.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      },
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 300,
    });

    if (response.isErr()) {
      return err({
        source: "llm",
        code: this.mapHttpCode(response.error.httpStatus, response.error.code),
        provider: "ollama",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    const content = response.value.message?.content?.trim();
    if (!content) {
      return err({
        source: "llm",
        code: "malformed_response",
        provider: "ollama",
        message: "Ollama chat payload did not contain message.content.",
        retryable: false,
      });
    }

    return ok(content);
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

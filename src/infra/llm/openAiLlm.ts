import type { LlmPort } from "../../core/ports/outboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../http/httpJsonClient";

type OpenAiChatMessage = {
  content?: string | Array<{ type?: string; text?: string }>;
};

type OpenAiChatChoice = {
  message?: OpenAiChatMessage;
};

type OpenAiChatResponse = {
  choices?: OpenAiChatChoice[];
};

/**
 * Encapsulates OpenAI chat-model access so synthesis and normalization can swap providers without use-case changes.
 */
export class OpenAiLlm implements LlmPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    private readonly httpClient = new HttpJsonClient(),
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "OPENAI_API_KEY is required when LLM_PROVIDER is set to openai.",
      );
    }
  }

  /**
   * Reuses one chat path so normalization behavior remains consistent with synthesis behavior.
   */
  async summarize(prompt: string): Promise<Result<string, AppBoundaryError>> {
    return this.chat(prompt);
  }

  /**
   * Routes final-thesis generation through the same reliability and error mapping policy as summarize.
   */
  async synthesize(prompt: string): Promise<Result<string, AppBoundaryError>> {
    return this.chat(prompt);
  }

  private extractTextContent(content: OpenAiChatMessage["content"]): string {
    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  private async chat(
    prompt: string,
  ): Promise<Result<string, AppBoundaryError>> {
    const trimmedBase = this.baseUrl.replace(/\/+$/, "");
    const response = await this.httpClient.requestJson<OpenAiChatResponse>({
      url: `${trimmedBase}/v1/chat/completions`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: {
        model: this.model,
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
        provider: "openai",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    const content = this.extractTextContent(
      response.value.choices?.at(0)?.message?.content,
    );
    if (!content) {
      return err({
        source: "llm",
        code: "malformed_response",
        provider: "openai",
        message:
          "OpenAI chat payload did not contain a usable choices[0].message.content value.",
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

import type { LlmPort } from "../../core/ports/outboundPorts";

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
  ) {}

  /**
   * Reuses a single chat path to keep prompt handling policy consistent across intermediate stages.
   */
  async summarize(prompt: string): Promise<string> {
    return this.chat(prompt);
  }

  /**
   * Keeps final-thesis generation behind the same reliability and fallback policy as other LLM calls.
   */
  async synthesize(prompt: string): Promise<string> {
    return this.chat(prompt);
  }

  private async chat(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return "Fallback synthesis: model unavailable, use stored facts and metrics only.";
      }

      const payload = (await response.json()) as OllamaChatResponse;
      return (
        payload.message?.content ?? "Fallback synthesis: empty model response."
      );
    } catch {
      return "Fallback synthesis: ollama request failed or timed out.";
    } finally {
      clearTimeout(timeout);
    }
  }
}

import { env } from "../shared/config/env";

/**
 * Runs a minimal Ollama chat probe using the same model/base-url contract as runtime synthesis.
 * This gives a fast way to validate connectivity and latency without running the full pipeline.
 */
class OllamaProbe {
  /**
   * Executes one non-streaming chat request and prints key timing/status fields for diagnostics.
   */
  static async run(): Promise<void> {
    const startedAt = Date.now();

    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: env.OLLAMA_CHAT_MODEL,
        stream: false,
        messages: [{ role: "user", content: "Reply with OK only." }],
      }),
      signal: AbortSignal.timeout(env.OLLAMA_CHAT_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;
    const payloadText = await response.text();

    console.log(
      JSON.stringify(
        {
          baseUrl: env.OLLAMA_BASE_URL,
          model: env.OLLAMA_CHAT_MODEL,
          timeoutMs: env.OLLAMA_CHAT_TIMEOUT_MS,
          status: response.status,
          durationMs,
          bodyPreview: payloadText.slice(0, 280),
        },
        null,
        2,
      ),
    );
  }
}

await OllamaProbe.run();

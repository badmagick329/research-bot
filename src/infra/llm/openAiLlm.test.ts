import { afterEach, describe, expect, it } from "bun:test";
import { OpenAiLlm } from "./openAiLlm";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAiLlm", () => {
  it("maps chat completion payloads with string content", async () => {
    let requestedUrl = "";
    let authHeader = "";
    setFetch(async (input, init) => {
      requestedUrl = String(input);
      authHeader = String(init?.headers ? (init.headers as Record<string, string>).authorization : "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "normalized output",
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const llm = new OpenAiLlm(
      "https://api.openai.com",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.synthesize("prompt");

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }
    expect(result.value).toBe("normalized output");
    expect(requestedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(authHeader).toBe("Bearer test-key");
  });

  it("maps chat completion payloads with content parts", async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: "text", text: "part 1" },
                    { type: "text", text: "part 2" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const llm = new OpenAiLlm(
      "https://api.openai.com/",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.summarize("prompt");

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }
    expect(result.value).toBe("part 1\npart 2");
  });

  it("maps auth failures to auth_invalid boundary errors", async () => {
    setFetch(async () => new Response("unauthorized", { status: 401 }));

    const llm = new OpenAiLlm(
      "https://api.openai.com",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.synthesize("prompt");

    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("auth_invalid");
      expect(result.error.provider).toBe("openai");
    }
  });

  it("maps rate-limit failures to rate_limited boundary errors", async () => {
    setFetch(async () => new Response("limited", { status: 429 }));

    const llm = new OpenAiLlm(
      "https://api.openai.com",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.synthesize("prompt");

    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("rate_limited");
      expect(result.error.provider).toBe("openai");
    }
  });

  it("maps malformed JSON payloads to invalid_json boundary errors", async () => {
    setFetch(async () => new Response("not-json", { status: 200 }));

    const llm = new OpenAiLlm(
      "https://api.openai.com",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.synthesize("prompt");

    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("invalid_json");
      expect(result.error.provider).toBe("openai");
    }
  });

  it("returns malformed_response when content is absent", async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: {} }],
          }),
          { status: 200 },
        ),
    );

    const llm = new OpenAiLlm(
      "https://api.openai.com",
      "test-key",
      "gpt-4.1",
      5_000,
    );

    const result = await llm.synthesize("prompt");

    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("malformed_response");
      expect(result.error.provider).toBe("openai");
    }
  });

  it("throws when api key is missing", () => {
    expect(
      () => new OpenAiLlm("https://api.openai.com", "", "gpt-4.1"),
    ).toThrow("OPENAI_API_KEY is required");
  });
});

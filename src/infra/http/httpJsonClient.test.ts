import { afterEach, describe, expect, it } from "bun:test";
import { HttpJsonClient } from "./httpJsonClient";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HttpJsonClient", () => {
  it("retries retryable failures up to configured attempts", async () => {
    let attempts = 0;

    setFetch(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("socket reset");
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new HttpJsonClient();
    const result = await client.requestJson<{ ok: boolean }>({
      url: "https://example.test/retry",
      method: "GET",
      timeoutMs: 500,
      retries: 2,
      retryDelayMs: 1,
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("maps aborted requests to timeout errors", async () => {
    setFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }

          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const client = new HttpJsonClient();
    const result = await client.requestJson({
      url: "https://example.test/timeout",
      method: "GET",
      timeoutMs: 5,
      retries: 0,
      retryDelayMs: 1,
    });

    expect(result.isErr()).toBeTrue();
    if (result.isOk()) {
      throw new Error("expected timeout error");
    }

    expect(result.error.code).toBe("timeout");
    expect(result.error.retryable).toBeTrue();
  });

  it("maps non-success statuses with retryability metadata", async () => {
    setFetch(async () => new Response("unavailable", { status: 503 }));

    const client = new HttpJsonClient();
    const result = await client.requestJson({
      url: "https://example.test/status",
      method: "GET",
      timeoutMs: 500,
      retries: 0,
      retryDelayMs: 1,
    });

    expect(result.isErr()).toBeTrue();
    if (result.isOk()) {
      throw new Error("expected non-success status error");
    }

    expect(result.error.code).toBe("non_success_status");
    expect(result.error.httpStatus).toBe(503);
    expect(result.error.retryable).toBeTrue();
  });

  it("maps invalid JSON payloads as non-retryable", async () => {
    setFetch(async () => new Response("not-json", { status: 200 }));

    const client = new HttpJsonClient();
    const result = await client.requestJson({
      url: "https://example.test/json",
      method: "GET",
      timeoutMs: 500,
      retries: 0,
      retryDelayMs: 1,
    });

    expect(result.isErr()).toBeTrue();
    if (result.isOk()) {
      throw new Error("expected invalid json error");
    }

    expect(result.error.code).toBe("invalid_json");
    expect(result.error.retryable).toBeFalse();
  });
});

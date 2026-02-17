import { afterEach, describe, expect, it } from "bun:test";
import { FinnhubNewsProvider } from "./finnhubNewsProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FinnhubNewsProvider", () => {
  it("maps provider payloads to normalized items", async () => {
    let requestedUrl = "";
    setFetch(async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify([
          {
            id: 9001,
            category: "company",
            datetime: 1_705_000_000,
            headline: "AAPL announces new product",
            related: "AAPL,MSFT",
            source: "Reuters",
            summary: "Launch event guidance details",
            url: "https://news.example/aapl-1",
          },
        ]),
        { status: 200 },
      );
    });

    const provider = new FinnhubNewsProvider(
      "https://finnhub.io",
      "test-key",
      5_000,
    );

    const items = await provider.fetchArticles({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 10,
    });

    expect(requestedUrl).toContain("symbol=AAPL");
    expect(requestedUrl).toContain("from=2026-01-01");
    expect(requestedUrl).toContain("to=2026-01-10");
    expect(requestedUrl).toContain("token=test-key");

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "finnhub-9001",
      provider: "finnhub",
      providerItemId: "9001",
      title: "AAPL announces new product",
      summary: "Launch event guidance details",
      content: "Launch event guidance details",
      url: "https://news.example/aapl-1",
      authors: ["Reuters"],
      publishedAt: new Date(1_705_000_000 * 1000),
      language: "en",
      symbols: ["AAPL", "MSFT"],
      topics: ["company"],
      sentiment: undefined,
      sourceType: "api",
      rawPayload: {
        id: 9001,
        category: "company",
        datetime: 1_705_000_000,
        headline: "AAPL announces new product",
        related: "AAPL,MSFT",
        source: "Reuters",
        summary: "Launch event guidance details",
        url: "https://news.example/aapl-1",
      },
    });
  });

  it("handles missing optional fields with safe defaults", async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              datetime: 1_705_111_111,
              headline: "MSFT update",
            },
          ]),
          { status: 200 },
        ),
    );

    const provider = new FinnhubNewsProvider(
      "https://finnhub.io",
      "test-key",
      5_000,
    );

    const items = await provider.fetchArticles({
      symbol: "MSFT",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.providerItemId).toBe("MSFT-1705111111-0");
    expect(items[0]?.content).toBe("MSFT update");
    expect(items[0]?.symbols).toEqual(["MSFT"]);
    expect(items[0]?.topics).toEqual(["market-news"]);
    expect(items[0]?.authors).toEqual([]);
    expect(items[0]?.url).toBe("");
  });

  it("enforces request limit and skips invalid rows", async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify([
            { headline: "Valid 1", datetime: 1_700_000_000 },
            { headline: "   ", datetime: 1_700_000_001 },
            { headline: "Valid 2", datetime: 1_700_000_002 },
          ]),
          { status: 200 },
        ),
    );

    const provider = new FinnhubNewsProvider(
      "https://finnhub.io",
      "test-key",
      5_000,
    );

    const items = await provider.fetchArticles({
      symbol: "NVDA",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 2,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Valid 1");
  });

  it("returns empty list when provider responds with non-200", async () => {
    setFetch(async () => new Response("rate limit", { status: 429 }));

    const provider = new FinnhubNewsProvider(
      "https://finnhub.io",
      "test-key",
      5_000,
    );

    const items = await provider.fetchArticles({
      symbol: "AAPL",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(items).toEqual([]);
  });

  it("throws when api key is missing", () => {
    expect(() => new FinnhubNewsProvider("https://finnhub.io", "")).toThrow(
      "FINNHUB_API_KEY is required",
    );
  });
});

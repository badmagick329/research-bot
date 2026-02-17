import { afterEach, describe, expect, it } from "bun:test";
import { AlphaVantageNewsProvider } from "../../../../infra/providers/alphavantage/alphaVantageNewsProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AlphaVantageNewsProvider", () => {
  it("maps provider payloads to normalized items", async () => {
    let requestedUrl = "";
    setFetch(async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          feed: [
            {
              uuid: "av-1",
              title: "AAPL outlook improves",
              summary: "Demand trends stabilized",
              url: "https://news.example/aapl-av-1",
              time_published: "20260110T133000",
              authors: ["Reuters"],
              topics: [{ topic: "technology" }],
              ticker_sentiment: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const provider = new AlphaVantageNewsProvider(
      "https://www.alphavantage.co",
      "test-key",
      5_000,
    );

    const items = await provider.fetchArticles({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 10,
    });

    expect(requestedUrl).toContain("function=NEWS_SENTIMENT");
    expect(requestedUrl).toContain("tickers=AAPL");
    expect(requestedUrl).toContain("apikey=test-key");

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "alphavantage-av-1",
      provider: "alphavantage",
      providerItemId: "av-1",
      title: "AAPL outlook improves",
      summary: "Demand trends stabilized",
      content: "Demand trends stabilized",
      url: "https://news.example/aapl-av-1",
      authors: ["Reuters"],
      publishedAt: new Date("2026-01-10T13:30:00.000Z"),
      language: "en",
      symbols: ["AAPL", "MSFT"],
      topics: ["technology"],
      sentiment: undefined,
      sourceType: "api",
      rawPayload: {
        uuid: "av-1",
        title: "AAPL outlook improves",
        summary: "Demand trends stabilized",
        url: "https://news.example/aapl-av-1",
        time_published: "20260110T133000",
        authors: ["Reuters"],
        topics: [{ topic: "technology" }],
        ticker_sentiment: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
      },
    });
  });

  it("returns empty list on non-200 responses", async () => {
    setFetch(async () => new Response("too many requests", { status: 429 }));

    const provider = new AlphaVantageNewsProvider(
      "https://www.alphavantage.co",
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
    expect(
      () => new AlphaVantageNewsProvider("https://www.alphavantage.co", ""),
    ).toThrow("ALPHA_VANTAGE_API_KEY is required");
  });
});

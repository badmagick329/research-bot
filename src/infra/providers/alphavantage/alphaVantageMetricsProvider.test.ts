import { afterEach, describe, expect, it } from "bun:test";
import { AlphaVantageMetricsProvider } from "./alphaVantageMetricsProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AlphaVantageMetricsProvider", () => {
  it("maps overview payload into normalized market metrics", async () => {
    let requestedUrl = "";
    setFetch(async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          Symbol: "AAPL",
          Currency: "USD",
          MarketCapitalization: "3000000000000",
          PERatio: "31.7",
          QuarterlyRevenueGrowthYOY: "0.08",
        }),
        { status: 200 },
      );
    });

    const asOf = new Date("2026-01-10T00:00:00.000Z");
    const provider = new AlphaVantageMetricsProvider(
      "https://www.alphavantage.co",
      "test-key",
      5_000,
    );

    const result = await provider.fetchMetrics({ symbol: "aapl", asOf });

    expect(requestedUrl).toContain("function=OVERVIEW");
    expect(requestedUrl).toContain("symbol=AAPL");
    expect(requestedUrl).toContain("apikey=test-key");

    expect(result.metrics).toEqual([
      {
        id: "alphavantage-AAPL-market_cap-2026-01-10T00:00:00.000Z",
        provider: "alphavantage",
        symbol: "AAPL",
        metricName: "market_cap",
        metricValue: 3000000000000,
        metricUnit: "usd",
        currency: "USD",
        asOf,
        periodType: "point_in_time",
        confidence: 0.85,
        rawPayload: {
          Symbol: "AAPL",
          Currency: "USD",
          MarketCapitalization: "3000000000000",
          PERatio: "31.7",
          QuarterlyRevenueGrowthYOY: "0.08",
        },
      },
      {
        id: "alphavantage-AAPL-price_to_earnings-2026-01-10T00:00:00.000Z",
        provider: "alphavantage",
        symbol: "AAPL",
        metricName: "price_to_earnings",
        metricValue: 31.7,
        metricUnit: "multiple",
        currency: "USD",
        asOf,
        periodType: "point_in_time",
        confidence: 0.85,
        rawPayload: {
          Symbol: "AAPL",
          Currency: "USD",
          MarketCapitalization: "3000000000000",
          PERatio: "31.7",
          QuarterlyRevenueGrowthYOY: "0.08",
        },
      },
      {
        id: "alphavantage-AAPL-revenue_growth_yoy-2026-01-10T00:00:00.000Z",
        provider: "alphavantage",
        symbol: "AAPL",
        metricName: "revenue_growth_yoy",
        metricValue: 0.08,
        metricUnit: "ratio",
        currency: "USD",
        asOf,
        periodType: "quarter",
        confidence: 0.85,
        rawPayload: {
          Symbol: "AAPL",
          Currency: "USD",
          MarketCapitalization: "3000000000000",
          PERatio: "31.7",
          QuarterlyRevenueGrowthYOY: "0.08",
        },
      },
    ]);

    expect(result.diagnostics).toEqual({
      provider: "alphavantage",
      symbol: "AAPL",
      status: "ok",
      metricCount: 3,
    });
  });

  it("returns rate-limited diagnostics on 429 responses", async () => {
    setFetch(async () => new Response("too many requests", { status: 429 }));

    const provider = new AlphaVantageMetricsProvider(
      "https://www.alphavantage.co",
      "test-key",
      5_000,
    );

    const result = await provider.fetchMetrics({ symbol: "AAPL" });

    expect(result.metrics).toEqual([]);
    expect(result.diagnostics.status).toBe("rate_limited");
    expect(result.diagnostics.httpStatus).toBe(429);
  });

  it("throws on auth failures", async () => {
    setFetch(async () => new Response("forbidden", { status: 403 }));

    const provider = new AlphaVantageMetricsProvider(
      "https://www.alphavantage.co",
      "test-key",
      5_000,
    );

    await expect(provider.fetchMetrics({ symbol: "AAPL" })).rejects.toThrow(
      "ALPHAVANTAGE_METRICS_FATAL_AUTH",
    );
  });

  it("throws when api key is missing", () => {
    expect(
      () => new AlphaVantageMetricsProvider("https://www.alphavantage.co", ""),
    ).toThrow("ALPHA_VANTAGE_API_KEY is required");
  });
});

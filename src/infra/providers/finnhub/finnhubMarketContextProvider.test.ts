import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import { FinnhubMarketContextProvider } from "./finnhubMarketContextProvider";

describe("FinnhubMarketContextProvider", () => {
  it("maps peer, earnings, and analyst payloads into normalized context signals", async () => {
    const responses: unknown[] = [
      ["MSFT", "AMD"],
      { metric: { peTTM: 50, revenueGrowthTTMYoy: 0.2 } },
      { metric: { peTTM: 25, revenueGrowthTTMYoy: 0.1 } },
      { metric: { peTTM: 35, revenueGrowthTTMYoy: 0.15 } },
      {
        earningsCalendar: [
          { date: "2026-03-10", epsActual: 1.4, epsEstimate: 1.2 },
          { date: "2026-02-05", epsActual: 1.1, epsEstimate: 1.0 },
        ],
      },
      [
        {
          period: "2026-02-01",
          strongBuy: 10,
          buy: 20,
          hold: 5,
          sell: 2,
          strongSell: 1,
        },
        {
          period: "2026-01-01",
          strongBuy: 8,
          buy: 18,
          hold: 7,
          sell: 3,
          strongSell: 1,
        },
      ],
      {
        s: "ok",
        c: Array.from({ length: 130 }, (_, index) => 100 + index * 0.5),
      },
    ];

    const httpClient = {
      requestJson: async () => ok(responses.shift()),
    } as never;

    const provider = new FinnhubMarketContextProvider(
      "https://finnhub.io",
      "token",
      1_000,
      httpClient as never,
    );

    const result = await provider.fetchMarketContext({
      symbol: "NVDA",
      asOf: new Date("2026-02-26T00:00:00.000Z"),
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error("expected market context result");
    }

    expect(result.value.peerRelativeValuation.length).toBeGreaterThan(0);
    expect(result.value.earningsGuidance.length).toBeGreaterThan(0);
    expect(result.value.analystTrend.length).toBe(3);
    expect(result.value.priceContext.length).toBe(3);
    expect(result.value.diagnostics.status).toBe("ok");
    expect(result.value.diagnostics.itemCounts.priceContext).toBe(3);
  });

  it("maps transport errors to boundary errors", async () => {
    const httpClient = {
      requestJson: async () =>
        err({
          code: "transport_error" as const,
          message: "network down",
          retryable: true,
          httpStatus: undefined,
          cause: new Error("network down"),
        }),
    } as never;

    const provider = new FinnhubMarketContextProvider(
      "https://finnhub.io",
      "token",
      1_000,
      httpClient,
    );

    const result = await provider.fetchMarketContext({
      symbol: "NVDA",
      asOf: new Date("2026-02-26T00:00:00.000Z"),
    });

    expect(result.isErr()).toBeTrue();
    if (result.isOk()) {
      throw new Error("expected transport error");
    }

    expect(result.error.provider).toBe("finnhub-market-context");
    expect(result.error.source).toBe("metrics");
  });

  it("degrades gracefully when price-context candle endpoint is unavailable", async () => {
    const responses: Array<unknown | ReturnType<typeof err>> = [
      ["MSFT", "AMD"],
      { metric: { peTTM: 50, revenueGrowthTTMYoy: 0.2 } },
      { metric: { peTTM: 25, revenueGrowthTTMYoy: 0.1 } },
      { metric: { peTTM: 35, revenueGrowthTTMYoy: 0.15 } },
      {
        earningsCalendar: [
          { date: "2026-03-10", epsActual: 1.4, epsEstimate: 1.2 },
        ],
      },
      [
        {
          period: "2026-02-01",
          strongBuy: 10,
          buy: 20,
          hold: 5,
          sell: 2,
          strongSell: 1,
        },
      ],
      err({
        code: "non_success_status" as const,
        message: "HTTP request failed with status 403.",
        retryable: false,
        httpStatus: 403,
      }),
    ];

    const httpClient = {
      requestJson: async () => {
        const next = responses.shift();
        if (next && typeof next === "object" && "isErr" in next) {
          return next;
        }
        return ok(next);
      },
    } as never;

    const provider = new FinnhubMarketContextProvider(
      "https://finnhub.io",
      "token",
      1_000,
      httpClient as never,
    );

    const result = await provider.fetchMarketContext({
      symbol: "NVDA",
      asOf: new Date("2026-02-26T00:00:00.000Z"),
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error("expected market context result");
    }

    expect(result.value.peerRelativeValuation.length).toBeGreaterThan(0);
    expect(result.value.priceContext).toEqual([]);
    expect(result.value.diagnostics.reason).toContain("price_context_unavailable");
  });
});

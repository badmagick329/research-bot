import { afterEach, describe, expect, it } from "bun:test";
import { FredMacroProvider } from "./fredMacroProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FredMacroProvider", () => {
  it("maps configured FRED series into normalized macro metrics including derived YoY and curve", async () => {
    const seriesPayload = (
      latest: string,
      previousYear: string,
      latestDate = "2026-02-01",
      previousDate = "2025-02-01",
    ) => {
      const extras = Array.from({ length: 11 }, (_, index) => {
        const date = new Date("2025-01-01T00:00:00.000Z");
        date.setUTCMonth(date.getUTCMonth() - index);
        return {
          date: date.toISOString().slice(0, 10),
          value: "100",
        };
      });
      return {
        observations: [
          { date: latestDate, value: latest },
          { date: previousDate, value: previousYear },
          ...extras,
        ],
      };
    };

    setFetch(async (input) => {
      const url = String(input);
      if (url.includes("series_id=FEDFUNDS")) {
        return new Response(
          JSON.stringify({
            observations: [{ date: "2026-02-01", value: "4.50" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("series_id=DGS10")) {
        return new Response(
          JSON.stringify({
            observations: [{ date: "2026-02-01", value: "4.20" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("series_id=DGS2")) {
        return new Response(
          JSON.stringify({
            observations: [{ date: "2026-02-01", value: "4.00" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("series_id=CPIAUCSL")) {
        return new Response(JSON.stringify(seriesPayload("312", "300")), {
          status: 200,
        });
      }
      if (url.includes("series_id=UNRATE")) {
        return new Response(
          JSON.stringify({
            observations: [{ date: "2026-02-01", value: "4.1" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("series_id=INDPRO")) {
        return new Response(JSON.stringify(seriesPayload("105", "100")), {
          status: 200,
        });
      }
      if (url.includes("series_id=RSAFS")) {
        return new Response(JSON.stringify(seriesPayload("420", "400")), {
          status: 200,
        });
      }
      if (url.includes("series_id=DCOILWTICO")) {
        return new Response(
          JSON.stringify({
            observations: [{ date: "2026-02-01", value: "75.5" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ observations: [] }), { status: 200 });
    });

    const provider = new FredMacroProvider(
      "https://api.stlouisfed.org",
      "fred-key",
    );
    const result = await provider.fetchMacroContext({
      symbol: "AAPL",
      asOf: new Date("2026-02-20T00:00:00.000Z"),
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const metricNames = result.value.metrics.map((metric) => metric.metricName);
    expect(metricNames).toContain("macro_fed_funds_rate");
    expect(metricNames).toContain("macro_us10y_yield");
    expect(metricNames).toContain("macro_us2y_yield");
    expect(metricNames).toContain("macro_yield_curve_10y_2y");
    expect(metricNames).toContain("macro_cpi_yoy");
    expect(metricNames).toContain("macro_industrial_production_yoy");
    expect(metricNames).toContain("macro_retail_sales_yoy");
    expect(metricNames).toContain("macro_wti_oil_price");
    expect(result.value.diagnostics[0]?.status).toBe("ok");
  });

  it("maps 429 responses to rate_limited boundary error", async () => {
    setFetch(async () => new Response("too many requests", { status: 429 }));
    const provider = new FredMacroProvider(
      "https://api.stlouisfed.org",
      "fred-key",
      5_000,
    );
    const result = await provider.fetchMacroContext({ symbol: "AAPL" });
    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("rate_limited");
      expect(result.error.provider).toBe("fred");
    }
  });
});

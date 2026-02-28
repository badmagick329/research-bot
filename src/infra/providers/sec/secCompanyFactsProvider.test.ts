import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import { SecCompanyFactsProvider } from "./secCompanyFactsProvider";
import type { HttpClientError, HttpJsonClient } from "../../http/httpJsonClient";

const buildHttpClient = (handler: (url: string) => unknown): HttpJsonClient =>
  ({
    requestJson: async ({ url }: { url: string }) => {
      const response = handler(url);
      if ((response as HttpClientError)?.code) {
        return err(response as HttpClientError);
      }
      return ok(response);
    },
  }) as unknown as HttpJsonClient;

describe("SecCompanyFactsProvider", () => {
  it("maps SEC companyfacts payload to KPI-centric normalized metrics", async () => {
    const httpClient = buildHttpClient((url) => {
      if (url.includes("company_tickers.json")) {
        return {
          "0": { ticker: "NVDA", cik_str: 1045810 },
        };
      }

      if (url.includes("/api/xbrl/companyfacts/CIK0001045810.json")) {
        return {
          facts: {
            "us-gaap": {
              RevenueFromContractWithCustomerExcludingAssessedTax: {
                units: {
                  USD: [
                    { val: 120, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 },
                    { val: 110, start: "2025-07-01", end: "2025-09-30", form: "10-Q", fp: "Q3", fy: 2025 },
                    { val: 105, start: "2025-04-01", end: "2025-06-30", form: "10-Q", fp: "Q2", fy: 2025 },
                    { val: 100, start: "2025-01-01", end: "2025-03-31", form: "10-Q", fp: "Q1", fy: 2025 },
                    { val: 80, start: "2024-10-01", end: "2024-12-31", form: "10-Q", fp: "Q4", fy: 2024 },
                  ],
                },
              },
              GrossProfit: {
                units: {
                  USD: [{ val: 72, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 }],
                },
              },
              OperatingIncomeLoss: {
                units: {
                  USD: [{ val: 42, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 }],
                },
              },
              NetIncomeLoss: {
                units: {
                  USD: [{ val: 30, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 }],
                },
              },
              EarningsPerShareDiluted: {
                units: {
                  "USD/shares": [{ val: 1.75, end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 }],
                },
              },
              WeightedAverageNumberOfDilutedSharesOutstanding: {
                units: {
                  shares: [
                    { val: 2500, end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 },
                    { val: 2520, end: "2025-09-30", form: "10-Q", fp: "Q3", fy: 2025 },
                    { val: 2540, end: "2025-06-30", form: "10-Q", fp: "Q2", fy: 2025 },
                    { val: 2560, end: "2025-03-31", form: "10-Q", fp: "Q1", fy: 2025 },
                    { val: 2600, end: "2024-12-31", form: "10-Q", fp: "Q4", fy: 2024 },
                  ],
                },
              },
              NetCashProvidedByUsedInOperatingActivities: {
                units: {
                  USD: [
                    { val: 20, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 },
                    { val: 18, start: "2025-07-01", end: "2025-09-30", form: "10-Q", fp: "Q3", fy: 2025 },
                    { val: 17, start: "2025-04-01", end: "2025-06-30", form: "10-Q", fp: "Q2", fy: 2025 },
                    { val: 16, start: "2025-01-01", end: "2025-03-31", form: "10-Q", fp: "Q1", fy: 2025 },
                  ],
                },
              },
              PaymentsToAcquirePropertyPlantAndEquipment: {
                units: {
                  USD: [
                    { val: -5, start: "2025-10-01", end: "2025-12-31", form: "10-Q", fp: "Q4", fy: 2025 },
                    { val: -4, start: "2025-07-01", end: "2025-09-30", form: "10-Q", fp: "Q3", fy: 2025 },
                    { val: -4, start: "2025-04-01", end: "2025-06-30", form: "10-Q", fp: "Q2", fy: 2025 },
                    { val: -3, start: "2025-01-01", end: "2025-03-31", form: "10-Q", fp: "Q1", fy: 2025 },
                  ],
                },
              },
            },
          },
        };
      }

      return {};
    });

    const provider = new SecCompanyFactsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      10_000,
      16,
      httpClient,
    );

    const result = await provider.fetchCompanyFacts({
      symbol: "nvda",
      asOf: new Date("2026-02-28T00:00:00.000Z"),
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.diagnostics.status).toBe("ok");
    const names = new Set(result.value.metrics.map((metric) => metric.metricName));
    expect(names.has("revenue_ttm")).toBeTrue();
    expect(names.has("revenue_yoy")).toBeTrue();
    expect(names.has("revenue_growth_yoy")).toBeTrue();
    expect(names.has("gross_margin")).toBeTrue();
    expect(names.has("operating_margin")).toBeTrue();
    expect(names.has("profit_margin")).toBeTrue();
    expect(names.has("eps")).toBeTrue();
    expect(names.has("operating_cash_flow_ttm")).toBeTrue();
    expect(names.has("capex_ttm")).toBeTrue();
    expect(names.has("shares_diluted_yoy_change")).toBeTrue();
  });

  it("maps invalid JSON transport failures to boundary errors", async () => {
    const httpClient = buildHttpClient(() => ({
      code: "invalid_json",
      message: "bad json",
      retryable: false,
    }));

    const provider = new SecCompanyFactsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      10_000,
      16,
      httpClient,
    );

    const result = await provider.fetchCompanyFacts({
      symbol: "NVDA",
    });
    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("invalid_json");
      expect(result.error.provider).toBe("sec-companyfacts");
    }
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { SecEdgarFilingsProvider } from "./secEdgarFilingsProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SecEdgarFilingsProvider", () => {
  it("maps SEC submissions to normalized filings", async () => {
    const calls: string[] = [];

    setFetch(async (input) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("company_tickers.json")) {
        return new Response(
          JSON.stringify({
            "0": { ticker: "AAPL", cik_str: 320193 },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/submissions/CIK0000320193.json")) {
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-Q", "8-K"],
                accessionNumber: [
                  "0000320193-26-000010",
                  "0000320193-26-000011",
                ],
                filingDate: ["2026-01-30", "2026-02-02"],
                reportDate: ["2025-12-31", "2026-01-31"],
                primaryDocument: ["aapl-20251231x10q.htm", "aapl-8k.htm"],
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    const provider = new SecEdgarFilingsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/Archives/edgar/data",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      5_000,
    );

    const filings = await provider.fetchFilings({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-02-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(filings.isOk()).toBeTrue();
    if (filings.isErr()) {
      throw new Error(filings.error.message);
    }
    const values = filings.value;

    expect(calls[0]).toContain("company_tickers.json");
    expect(calls[1]).toContain("CIK0000320193.json");

    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      id: "sec-edgar-AAPL-0000320193-26-000010",
      provider: "sec-edgar",
      symbol: "AAPL",
      issuerName: "Apple Inc.",
      filingType: "10-Q",
      accessionNo: "0000320193-26-000010",
      periodEnd: new Date("2025-12-31T00:00:00.000Z"),
      rawPayload: {
        filingType: "10-Q",
        accessionNo: "0000320193-26-000010",
        filingDate: "2026-01-30",
        reportDate: "2025-12-31",
        primaryDocument: "aapl-20251231x10q.htm",
        extractionStatus: "metadata_only",
      },
    });
    expect(values[1]).toMatchObject({
      id: "sec-edgar-AAPL-0000320193-26-000011",
      provider: "sec-edgar",
      symbol: "AAPL",
      issuerName: "Apple Inc.",
      filingType: "8-K",
      accessionNo: "0000320193-26-000011",
      periodEnd: new Date("2026-01-31T00:00:00.000Z"),
      rawPayload: {
        filingType: "8-K",
        accessionNo: "0000320193-26-000011",
        filingDate: "2026-02-02",
        reportDate: "2026-01-31",
        primaryDocument: "aapl-8k.htm",
        extractionStatus: "metadata_only",
      },
    });
    expect(values[0]?.extractedFacts.some((fact) => fact.name === "content_extraction_status")).toBeTrue();
    expect(values[1]?.extractedFacts.some((fact) => fact.name === "content_extraction_status")).toBeTrue();
  });

  it("returns empty list when ticker cannot be resolved", async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({ "0": { ticker: "MSFT", cik_str: 789019 } }),
          {
            status: 200,
          },
        ),
    );

    const provider = new SecEdgarFilingsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/Archives/edgar/data",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      5_000,
    );

    const filings = await provider.fetchFilings({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-02-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(filings.isOk()).toBeTrue();
    if (filings.isErr()) {
      throw new Error(filings.error.message);
    }
    expect(filings.value).toEqual([]);
  });

  it("maps SEC auth failures to auth_invalid boundary errors", async () => {
    setFetch(async () => new Response("forbidden", { status: 403 }));

    const provider = new SecEdgarFilingsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/Archives/edgar/data",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      5_000,
    );

    const filings = await provider.fetchFilings({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-02-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(filings.isErr()).toBeTrue();
    if (filings.isErr()) {
      expect(filings.error.code).toBe("auth_invalid");
    }
  });

  it("maps malformed JSON payloads to invalid_json boundary errors", async () => {
    setFetch(async () => new Response("not-json", { status: 200 }));

    const provider = new SecEdgarFilingsProvider(
      "https://data.sec.gov",
      "https://www.sec.gov/Archives/edgar/data",
      "https://www.sec.gov/files/company_tickers.json",
      "research-bot-test/1.0 (contact: dev@example.com)",
      5_000,
    );

    const filings = await provider.fetchFilings({
      symbol: "aapl",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-02-10T00:00:00.000Z"),
      limit: 5,
    });

    expect(filings.isErr()).toBeTrue();
    if (filings.isErr()) {
      expect(filings.error.code).toBe("invalid_json");
    }
  });

  it("throws when user-agent is missing", () => {
    expect(
      () =>
        new SecEdgarFilingsProvider(
          "https://data.sec.gov",
          "https://www.sec.gov/Archives/edgar/data",
          "https://www.sec.gov/files/company_tickers.json",
          "",
        ),
    ).toThrow("SEC_EDGAR_USER_AGENT is required");
  });
});

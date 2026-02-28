import { afterEach, describe, expect, it } from "bun:test";
import { BlsMacroProvider } from "./blsMacroProvider";

const originalFetch = globalThis.fetch;

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void => {
  globalThis.fetch = handler as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BlsMacroProvider", () => {
  it("maps BLS response into normalized macro metrics including derived CPI YoY", async () => {
    setFetch(async () =>
      new Response(
        JSON.stringify({
          status: "REQUEST_SUCCEEDED",
          Results: {
            series: [
              {
                seriesID: "LNS14000000",
                data: [{ year: "2026", period: "M02", value: "4.1" }],
              },
              {
                seriesID: "CUUR0000SA0",
                data: [
                  { year: "2026", period: "M02", value: "312.0" },
                  { year: "2025", period: "M02", value: "300.0" },
                  { year: "2025", period: "M01", value: "300.0" },
                  { year: "2024", period: "M12", value: "300.0" },
                  { year: "2024", period: "M11", value: "300.0" },
                  { year: "2024", period: "M10", value: "300.0" },
                  { year: "2024", period: "M09", value: "300.0" },
                  { year: "2024", period: "M08", value: "300.0" },
                  { year: "2024", period: "M07", value: "300.0" },
                  { year: "2024", period: "M06", value: "300.0" },
                  { year: "2024", period: "M05", value: "300.0" },
                  { year: "2024", period: "M04", value: "300.0" },
                  { year: "2024", period: "M03", value: "300.0" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const provider = new BlsMacroProvider("https://api.bls.gov");
    const result = await provider.fetchMacroContext({
      symbol: "MSFT",
      asOf: new Date("2026-02-20T00:00:00.000Z"),
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const metricNames = result.value.metrics.map((metric) => metric.metricName);
    expect(metricNames).toContain("macro_bls_unemployment_rate");
    expect(metricNames).toContain("macro_bls_cpi_yoy");
    expect(result.value.diagnostics[0]?.status).toBe("ok");
  });

  it("maps failed BLS request to boundary error", async () => {
    setFetch(async () => new Response("forbidden", { status: 403 }));
    const provider = new BlsMacroProvider("https://api.bls.gov");
    const result = await provider.fetchMacroContext({ symbol: "MSFT" });
    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.code).toBe("auth_invalid");
      expect(result.error.provider).toBe("bls");
    }
  });
});

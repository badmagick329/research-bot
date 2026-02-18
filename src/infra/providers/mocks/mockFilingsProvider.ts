import type {
  FilingsProviderPort,
  FilingsRequest,
  NormalizedFiling,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import { ok, type Result } from "neverthrow";

/**
 * Supplies deterministic filing-shaped fixtures so ingestion contracts can be exercised without external APIs.
 */
export class MockFilingsProvider implements FilingsProviderPort {
  /**
   * Produces stable mock filings to validate downstream normalization and persistence assumptions.
   */
  async fetchFilings(
    request: FilingsRequest,
  ): Promise<Result<NormalizedFiling[], AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();

    return ok(
      [
        {
          id: `${symbol}-filing-10q`,
          provider: "mock-edgar",
          symbol,
          issuerName: `${symbol} Holdings Inc.`,
          filingType: "10-Q",
          accessionNo: `000000-${new Date().getFullYear()}-000001`,
          filedAt: request.to,
          periodEnd: new Date(request.to.getTime() - 30 * 24 * 60 * 60 * 1000),
          docUrl: `https://example.local/filings/${symbol}/10q`,
          sections: [
            {
              name: "Risk Factors",
              text: "Simulated supply chain and demand volatility risk.",
            },
            {
              name: "MD&A",
              text: "Simulated management discussion with growth and margin commentary.",
            },
          ],
          extractedFacts: [
            {
              name: "Revenue",
              value: "24500000000",
              unit: "USD",
              period: "Q",
            },
            {
              name: "GrossMargin",
              value: "0.58",
              unit: "ratio",
              period: "Q",
            },
          ],
          rawPayload: {
            formType: "10-Q",
            cik: "0000000000",
            filingHref: `https://example.local/raw/${symbol}/10q`,
          },
        },
      ].slice(0, Math.max(1, request.limit)),
    );
  }
}

import { describe, expect, it } from "bun:test";
import { DeterministicSynthesisEvidenceSelector } from "./evidenceSelection";
import type { DocumentEntity } from "../../../core/entities/document";

const now = new Date("2026-03-02T10:00:00.000Z");

const baseDoc = (args: Partial<DocumentEntity>): DocumentEntity => ({
  id: "doc",
  symbol: "AMZN",
  provider: "finnhub",
  providerItemId: "id",
  type: "news",
  title: "title",
  summary: "",
  content: "",
  url: "https://example.com",
  publishedAt: now,
  language: "en",
  topics: [],
  sourceType: "api",
  rawPayload: {},
  createdAt: now,
  ...args,
});

describe("DeterministicSynthesisEvidenceSelector", () => {
  it("keeps issuer anchor and rejects payload-only matches", () => {
    const selector = new DeterministicSynthesisEvidenceSelector(
      "high_precision",
      1,
      0,
      0,
      0,
      10,
      "default",
    );

    const docs: DocumentEntity[] = [
      baseDoc({
        id: "payload-only",
        title: "Broad market wrap with no issuer mention",
        content: "Indices moved today.",
        url: "https://example.com/payload",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "issuer",
        title: "AMZN updates AWS demand outlook and margin guidance",
        content:
          "AMZN guidance and revenue growth detail with margin and demand trend",
        url: "https://example.com/issuer",
        rawPayload: { related: "AMZN" },
      }),
    ];

    const selection = selector.selectRelevantDocuments({
      docs,
      symbol: "AMZN",
      identity: {
        requestedSymbol: "AMZN",
        canonicalSymbol: "AMZN",
        companyName: "Amazon.com, Inc.",
        aliases: ["AMZN", "Amazon"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      horizon: "1_2_quarters",
      selectedKpiNames: ["revenue_growth_yoy"],
    });

    expect(selection.issuerAnchorPresent).toBeTrue();
    expect(selection.selected.some((doc) => doc.id === "issuer")).toBeTrue();
    expect((selection.excludedByReason.payload_only_issuer_match ?? 0) > 0).toBeTrue();
  });

  it("invokes recovery for high payload-only ratio and restores issuer anchor from narrative company tokens", () => {
    const selector = new DeterministicSynthesisEvidenceSelector(
      "high_precision",
      1,
      0,
      0,
      0,
      10,
      "default",
    );

    const docs: DocumentEntity[] = [
      baseDoc({
        id: "payload-1",
        title: "Broad market recap",
        content: "Indices and rates only.",
        url: "https://example.com/p1",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-2",
        title: "Sector momentum round-up",
        content: "No issuer narrative details.",
        url: "https://example.com/p2",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-3",
        title: "Global macro pulse",
        content: "Inflation and rates discussion only.",
        url: "https://example.com/p3",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-4",
        title: "Major index movers list",
        content: "Ticker list without issuer narrative.",
        url: "https://example.com/p4",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "recoverable-issuer",
        title: "Amazon updates fulfillment productivity roadmap",
        content: "Amazon logistics productivity and margin execution update.",
        url: "https://example.com/recover",
        rawPayload: {},
      }),
    ];

    const selection = selector.selectRelevantDocuments({
      docs,
      symbol: "AMZN",
      identity: {
        requestedSymbol: "AMZN",
        canonicalSymbol: "AMZN",
        companyName: "Amazon.com, Inc.",
        aliases: ["AMZN"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      horizon: "1_2_quarters",
      selectedKpiNames: ["revenue_growth_yoy"],
    });

    expect(selection.payloadOnlyRecovery.recoveryInvoked).toBeTrue();
    expect(selection.payloadOnlyRecovery.recoveryStatus).toBe("recovered");
    expect(selection.payloadOnlyRecovery.issuerAnchorSelectedBefore).toBe(0);
    expect(selection.payloadOnlyRecovery.issuerAnchorSelectedAfter).toBeGreaterThan(0);
    expect(selection.selected.some((doc) => doc.id === "recoverable-issuer")).toBeTrue();
  });

  it("records not_recovered when payload-only concentration is high but no company tokens are available", () => {
    const selector = new DeterministicSynthesisEvidenceSelector(
      "high_precision",
      1,
      0,
      0,
      0,
      10,
      "default",
    );

    const docs: DocumentEntity[] = [
      baseDoc({
        id: "payload-only-1",
        title: "Macro digest",
        content: "No issuer context.",
        url: "https://example.com/po1",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-only-2",
        title: "Index close",
        content: "No issuer context.",
        url: "https://example.com/po2",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-only-3",
        title: "Rates dashboard",
        content: "No issuer context.",
        url: "https://example.com/po3",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-only-4",
        title: "Risk-on/risk-off",
        content: "No issuer context.",
        url: "https://example.com/po4",
        rawPayload: { related: "AMZN" },
      }),
      baseDoc({
        id: "payload-only-5",
        title: "Market breadth",
        content: "No issuer context.",
        url: "https://example.com/po5",
        rawPayload: { related: "AMZN" },
      }),
    ];

    const selection = selector.selectRelevantDocuments({
      docs,
      symbol: "AMZN",
      identity: undefined,
      horizon: "1_2_quarters",
      selectedKpiNames: [],
    });

    expect(selection.payloadOnlyRecovery.recoveryInvoked).toBeTrue();
    expect(selection.payloadOnlyRecovery.recoveryStatus).toBe("not_recovered");
    expect(selection.payloadOnlyRecovery.recoveryReason).toBe("missing_company_tokens");
    expect(selection.payloadOnlyRecovery.metricHeavyDueToNarrativeGap).toBeTrue();
  });
});

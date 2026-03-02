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
});

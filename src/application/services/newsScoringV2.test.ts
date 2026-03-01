import { describe, expect, it } from "bun:test";
import type { DocumentEntity } from "../../core/entities/document";
import {
  classifyEvidenceClass,
  classifyNewsDocumentClass,
  scoreNewsCandidate,
} from "./newsScoringV2";

const baseDoc = (overrides?: Partial<DocumentEntity>): DocumentEntity => ({
  id: "doc-1",
  symbol: "NVDA",
  provider: "finnhub",
  providerItemId: "n-1",
  type: "news",
  title: "NVIDIA guidance points to sustained data center demand",
  summary: "Guidance and margin durability in focus",
  content: "Demand and margin update linked to revenue growth and capex outlook.",
  url: "https://example.com/nvda-1",
  publishedAt: new Date("2026-02-20T00:00:00.000Z"),
  language: "en",
  topics: ["company-news"],
  sourceType: "api",
  rawPayload: {},
  createdAt: new Date("2026-02-20T00:00:00.000Z"),
  ...overrides,
});

describe("newsScoringV2", () => {
  it("classifies read-through evidence classes deterministically", () => {
    expect(classifyEvidenceClass("nvidia guidance update", true)).toBe("issuer");
    expect(classifyEvidenceClass("peer competitor margin pressure", false)).toBe(
      "peer",
    );
    expect(
      classifyEvidenceClass("supplier shipment channel inventory signal", false),
    ).toBe("supply_chain");
    expect(
      classifyEvidenceClass("customer contract win and enterprise order book", false),
    ).toBe("customer");
    expect(classifyEvidenceClass("industry demand backdrop", false)).toBe(
      "industry",
    );
  });

  it("scores issuer-matched materially higher than unrelated market-wrap headline", () => {
    const issuer = scoreNewsCandidate(
      {
        doc: baseDoc(),
        issuerMatched: true,
        horizon: "1_2_quarters",
        kpiNames: ["revenue_growth_yoy", "profit_margin"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    const noise = scoreNewsCandidate(
      {
        doc: baseDoc({
          id: "doc-2",
          title: "Stocks rose today in broad market wrap",
          summary: "Premarket ETF movers",
          content: "Shares rose and fell across sectors.",
          url: "https://example.com/noise",
        }),
        issuerMatched: false,
        horizon: "1_2_quarters",
        kpiNames: ["revenue_growth_yoy"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    expect(issuer.composite).toBeGreaterThan(noise.composite);
    expect(issuer.includedByThresholds).toBeTrue();
    expect(noise.includedByThresholds).toBeFalse();
    expect(noise.exclusionReason).toBe("explicit_market_noise_pattern");
  });

  it("classifies market-context and generic listicle artifacts before ranking", () => {
    expect(
      classifyNewsDocumentClass("stock market today market wrap", "issuer"),
    ).toBe("market_context");
    expect(
      classifyNewsDocumentClass("top stocks to buy this week", "industry"),
    ).toBe("generic_market_noise");
    expect(classifyNewsDocumentClass("issuer guidance update", "issuer")).toBe(
      "issuer_news",
    );
  });

  it("excludes duplicate URL or title candidates via novelty gate", () => {
    const seenUrls = new Set<string>(["example.com/dup"]);
    const seenTitles = new Set<string>(["nvidia guidance points to sustained data center demand"]);

    const duplicateUrl = scoreNewsCandidate(
      {
        doc: baseDoc({ url: "https://example.com/dup?utm_source=x" }),
        issuerMatched: true,
        horizon: "1_2_quarters",
        kpiNames: [],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: seenUrls,
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    const duplicateTitle = scoreNewsCandidate(
      {
        doc: baseDoc({ id: "doc-3", url: "https://example.com/new" }),
        issuerMatched: true,
        horizon: "1_2_quarters",
        kpiNames: [],
        seenTitleKeys: seenTitles,
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    expect(duplicateUrl.exclusionReason).toBe("duplicate_url");
    expect(duplicateTitle.exclusionReason).toBe("duplicate_title");
  });

  it("rewards horizon-fit timing cues and KPI-linked language", () => {
    const shortTerm = scoreNewsCandidate(
      {
        doc: baseDoc({
          title: "Next earnings guidance update could reset demand expectations",
          content: "Next earnings and guidance update drive near-term catalyst.",
        }),
        issuerMatched: true,
        horizon: "0_4_weeks",
        kpiNames: ["revenue_growth_yoy"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    const longTermMismatched = scoreNewsCandidate(
      {
        doc: baseDoc({
          id: "doc-4",
          title: "Next earnings guidance update could reset demand expectations",
          url: "https://example.com/nvda-4",
        }),
        issuerMatched: true,
        horizon: "1_3_years",
        kpiNames: ["price_to_book"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    expect(shortTerm.components.horizonRelevanceScore).toBeGreaterThan(
      longTermMismatched.components.horizonRelevanceScore,
    );
    expect(shortTerm.components.kpiLinkageScore).toBeGreaterThanOrEqual(40);
  });

  it("excludes payload-only issuer matches from issuer inclusion", () => {
    const payloadOnly = scoreNewsCandidate(
      {
        doc: baseDoc({
          id: "doc-5",
          title: "Industry update with no issuer mention",
          summary: "Broad sector context only",
          content: "No direct company context in title summary or content.",
          url: "https://example.com/industry-payload-only",
        }),
        issuerMatched: false,
        payloadOnlyIssuerMatch: true,
        horizon: "1_2_quarters",
        kpiNames: ["revenue_growth_yoy"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    expect(payloadOnly.includedByThresholds).toBeFalse();
    expect(payloadOnly.exclusionReason).toBe("payload_only_issuer_match");
  });

  it("keeps borderline issuer narratives as rankable candidates", () => {
    const borderlineIssuer = scoreNewsCandidate(
      {
        doc: baseDoc({
          id: "doc-6",
          title: "NVIDIA discusses demand trends ahead of earnings",
          summary: "Mixed margin outlook but direct issuer narrative remains.",
          content:
            "NVIDIA commentary highlights demand and next earnings context without explicit KPI aliases.",
          url: "https://example.com/nvda-borderline",
        }),
        issuerMatched: true,
        horizon: "1_2_quarters",
        kpiNames: ["free_cash_flow_margin"],
        seenTitleKeys: new Set<string>(),
        seenUrlKeys: new Set<string>(),
        sourceQualityMode: "default",
      },
      {
        minCompositeScore: 65,
        minMaterialityScore: 50,
        minKpiLinkageScore: 40,
        sourceQualityMode: "default",
      },
    );

    expect(borderlineIssuer.includedByThresholds).toBeTrue();
    expect(borderlineIssuer.exclusionReason).toBeUndefined();
  });
});


import { describe, expect, it } from "bun:test";
import type { DocumentEntity } from "../../core/entities/document";
import { scoreNewsCandidate } from "./newsScoringV2";

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
});


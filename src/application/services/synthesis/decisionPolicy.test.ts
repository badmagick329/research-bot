import { describe, expect, it } from "bun:test";
import { DeterministicSynthesisDecisionPolicy } from "./decisionPolicy";

describe("DeterministicSynthesisDecisionPolicy", () => {
  it("returns watch_low_quality when grace mode applies", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(
      3,
      true,
      () => "1.00",
      () => false,
    );

    const decision = policy.toActionDecision(
      "watch",
      { passed: false, failures: ["low_sector_kpi_quality"] },
      {
        mode: "grace_low_quality",
        coreRequiredCount: 2,
        coreCurrentCount: 2,
        coreCarriedCount: 0,
        sectorExpectedCount: 2,
        sectorCurrentCount: 0,
        sectorCarriedCount: 0,
        carryForwardMaxAgeDays: 90,
        carriedKpis: [],
      },
    );

    expect(decision).toBe("watch_low_quality");
  });

  it("builds buy decision when evidence is strong and valuation acceptable", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(
      3,
      true,
      () => "1.00",
      () => false,
    );

    const context = policy.buildDecisionContext(
      {
        selected: [],
        classifiedDocuments: [],
        selectedNewsLabels: [],
        newsLabelByDocumentId: new Map(),
        issuerAnchorPresent: true,
        includedByClass: { issuer: 2, peer: 0, supply_chain: 0, customer: 0, industry: 0 },
        excludedByClass: { issuer: 0, peer: 0, supply_chain: 0, customer: 0, industry: 0 },
        excludedByClassAndReason: {},
        relevantHeadlinesCount: 2,
        selectedRelevantCount: 2,
        lowRelevance: false,
        totalHeadlinesCount: 2,
        issuerMatchedHeadlinesCount: 2,
        excludedHeadlinesCount: 0,
        excludedHeadlineReasons: [],
        excludedHeadlineReasonSamples: [],
        averageCompositeScore: 80,
        excludedByReason: {},
        issuerAnchorCount: 2,
        prefilterClassCountsBefore: { issuer_news: 2, read_through_news: 0, market_context: 0, generic_market_noise: 0 },
        prefilterClassCountsAfter: { issuer_news: 2, read_through_news: 0, market_context: 0, generic_market_noise: 0 },
        issuerAnchorAvailable: true,
        issuerAnchorAvailableCount: 2,
        issuerMatchDiagnostics: { title: 2, summary: 0, content: 0, payload: 0, payloadOnlyRejected: 0 },
        scoreBreakdownSample: [],
      },
      [
        {
          id: "m1",
          symbol: "NVDA",
          provider: "x",
          metricName: "price_to_earnings",
          metricValue: 30,
          asOf: new Date(),
          periodType: "point_in_time",
          rawPayload: {},
          createdAt: new Date(),
        },
        {
          id: "m2",
          symbol: "NVDA",
          provider: "x",
          metricName: "revenue_growth_yoy",
          metricValue: 0.2,
          asOf: new Date(),
          periodType: "quarter",
          rawPayload: {},
          createdAt: new Date(),
        },
      ],
      [],
    );

    expect(policy.deriveDecisionFromContext(context).decision).toBe("buy");
  });
});

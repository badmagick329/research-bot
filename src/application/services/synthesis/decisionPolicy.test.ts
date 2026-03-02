import { describe, expect, it } from "bun:test";
import type { SignalPack, SufficiencyDiagnostics } from "../../../core/entities/research";
import { DeterministicSynthesisDecisionPolicy } from "./decisionPolicy";

const baseSignalPack = (): SignalPack => ({
  signals: [
    {
      signalId: "signal_revenue_growth_yoy",
      metricName: "revenue_growth_yoy",
      sourceMetricNames: ["revenue_growth_yoy"],
      normalizedValue: 0.72,
      direction: "positive",
      level: 0.7,
      trend: 0.6,
      acceleration: 0.2,
      freshnessDays: 7,
      historyZScore: 1.2,
      confidenceContribution: 0.8,
    },
    {
      signalId: "signal_price_to_earnings",
      metricName: "price_to_earnings",
      sourceMetricNames: ["price_to_earnings"],
      normalizedValue: 0.15,
      direction: "positive",
      level: 0.2,
      trend: 0.1,
      acceleration: 0.1,
      freshnessDays: 9,
      historyZScore: 0.3,
      confidenceContribution: 0.7,
    },
    {
      signalId: "signal_profit_margin",
      metricName: "profit_margin",
      sourceMetricNames: ["profit_margin"],
      normalizedValue: 0.5,
      direction: "positive",
      level: 0.5,
      trend: 0.25,
      acceleration: 0.1,
      freshnessDays: 12,
      historyZScore: 0.8,
      confidenceContribution: 0.75,
    },
  ],
  coverage: {
    totalSignals: 3,
    freshSignals: 3,
    staleSignals: 0,
    hasPeerRelativeContext: false,
  },
});

const sufficiency = (overrides?: Partial<SufficiencyDiagnostics>): SufficiencyDiagnostics => ({
  score: 70,
  threshold: 55,
  passed: true,
  missingCriticalDimensions: [],
  reasonCodes: [],
  ...overrides,
});

describe("DeterministicSynthesisDecisionPolicy", () => {
  it("returns watch_low_quality when only sector weakness exists in grace mode", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(3, true, () => "1.00");

    const decision = policy.toActionDecision(
      "watch",
      sufficiency({
        passed: false,
        reasonCodes: ["sector_kpi_depth_weak"],
        missingCriticalDimensions: [],
      }),
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

  it("builds buy seed when weighted signals are strong and sufficiency passes", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(3, true, () => "1.00");
    const result = policy.deriveDecisionFromSignals({
      signalPack: baseSignalPack(),
      sufficiency: sufficiency(),
      selection: {
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
        averageCompositeScore: 82,
        excludedByReason: {},
        issuerAnchorCount: 2,
        prefilterClassCountsBefore: { issuer_news: 2, read_through_news: 0, market_context: 0, generic_market_noise: 0 },
        prefilterClassCountsAfter: { issuer_news: 2, read_through_news: 0, market_context: 0, generic_market_noise: 0 },
        issuerAnchorAvailable: true,
        issuerAnchorAvailableCount: 2,
        issuerMatchDiagnostics: { title: 2, summary: 0, content: 0, payload: 0, payloadOnlyRejected: 0 },
        scoreBreakdownSample: [],
      },
      filings: [],
    });

    expect(result.decision).toBe("buy");
    expect(result.scoreBreakdown.netScore).toBeGreaterThan(0.2);
    expect(result.reasons).toContain("weighted_signals_support_buy");
  });
});

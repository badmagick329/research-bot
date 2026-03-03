import { describe, expect, it } from "bun:test";
import type { SignalPack, SufficiencyDiagnostics } from "../../../core/entities/research";
import type { MetricPointEntity } from "../../../core/entities/metric";
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
  it("returns insufficient_evidence when sufficiency fails", () => {
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

    expect(decision).toBe("insufficient_evidence");
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
        payloadOnlyRecovery: {
          payloadOnlyRatio: 0,
          recoveryInvoked: false,
          recoveryStatus: "not_needed",
          recoveryReason: "payload_only_ratio_below_threshold_or_issuer_anchor_present",
          issuerAnchorAvailableBefore: true,
          issuerAnchorAvailableAfter: true,
          issuerAnchorSelectedBefore: 2,
          issuerAnchorSelectedAfter: 2,
          metricHeavyDueToNarrativeGap: false,
        },
        scoreBreakdownSample: [],
      },
      filings: [],
    });

    expect(result.decision).toBe("buy");
    expect(result.scoreBreakdown.netScore).toBeGreaterThan(0.2);
    expect(result.reasons).toContain("weighted_signals_support_buy");
  });

  it("maps downside conditions to defensive actions and upside conditions to constructive actions", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(3, true, () => "1.00");
    const signalPack: SignalPack = {
      signals: [
        {
          signalId: "signal_inventory_days",
          metricName: "inventory_days",
          sourceMetricNames: ["inventory_days"],
          normalizedValue: -0.6,
          direction: "negative",
          level: -0.6,
          trend: -0.4,
          acceleration: -0.1,
          freshnessDays: 5,
          historyZScore: -1.1,
          confidenceContribution: 0.8,
        },
        {
          signalId: "signal_revenue_growth_yoy",
          metricName: "revenue_growth_yoy",
          sourceMetricNames: ["revenue_growth_yoy"],
          normalizedValue: 0.7,
          direction: "positive",
          level: 0.7,
          trend: 0.5,
          acceleration: 0.2,
          freshnessDays: 5,
          historyZScore: 1.4,
          confidenceContribution: 0.9,
        },
      ],
      coverage: {
        totalSignals: 2,
        freshSignals: 2,
        staleSignals: 0,
        hasPeerRelativeContext: false,
      },
    };
    const metrics: MetricPointEntity[] = [
      {
        id: "m1",
        symbol: "AMZN",
        provider: "alphavantage",
        metricName: "inventory_days",
        metricValue: 45,
        metricUnit: "days",
        currency: "USD",
        asOf: new Date("2026-02-20T00:00:00.000Z"),
        periodType: "quarter",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.9,
        rawPayload: {},
        createdAt: new Date("2026-02-20T00:00:00.000Z"),
      },
      {
        id: "m2",
        symbol: "AMZN",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-20T00:00:00.000Z"),
        periodType: "quarter",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.9,
        rawPayload: {},
        createdAt: new Date("2026-02-20T00:00:00.000Z"),
      },
    ];

    const rows = policy.buildActionMatrix(
      signalPack,
      metrics,
      [],
      new Map([
        ["inventory_days", "M1"],
        ["revenue_growth_yoy", "M2"],
      ]),
      new Map(),
    );

    const downside = rows.find((row) => row.signalId === "signal_inventory_days");
    const upside = rows.find((row) => row.signalId === "signal_revenue_growth_yoy");
    expect(downside?.conditionDirection).toBe("downside");
    expect(downside?.actionClass).toBe("defensive");
    expect(downside?.action).toContain("reduce risk exposure");
    expect(upside?.conditionDirection).toBe("upside");
    expect(upside?.actionClass).toBe("constructive");
    expect(upside?.action).toContain("add selectively");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => /deteriorates/.test(row.condition) && /add selectively/.test(row.action))).toBeFalse();
  });

  it("validates compiled rows and returns fallback trigger rows when invariants are violated", () => {
    const policy = new DeterministicSynthesisDecisionPolicy(3, true, () => "1.00");
    const invalidRows = [
      {
        signalId: "bad_row",
        label: "Bad row",
        currentValue: "n/a",
        triggerKind: "metric" as const,
        condition: "If inventory days deteriorates above 50",
        conditionDirection: "downside" as const,
        actionClass: "constructive" as const,
        action: "then add selectively",
        citations: [],
        hasNumericThreshold: true,
      },
    ];
    const violations = policy.validateTriggerRows(invalidRows);
    expect(violations.length).toBeGreaterThan(0);

    const fallbackRows = policy.buildFallbackTriggerRows({
      signalPack: {
        signals: [],
        coverage: {
          totalSignals: 0,
          freshSignals: 0,
          staleSignals: 0,
          hasPeerRelativeContext: false,
        },
      },
      metricLabelByName: new Map(),
    });
    expect(fallbackRows.length).toBe(0);
    expect(policy.validateTriggerRows(fallbackRows)).toHaveLength(0);
  });
});

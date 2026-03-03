import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type {
  ActionDecision,
  DecisionScoreBreakdown,
  KpiCoverageDiagnostics,
  SignalPack,
  SufficiencyDiagnostics,
} from "../../../core/entities/research";
import type {
  RelevanceSelection,
  SynthesisDecisionPolicyPort,
  ThesisCheckpoint,
} from "./types";

/**
 * Implements conservative deterministic decisioning while keeping investor-facing checkpoints business-specific.
 */
export class DeterministicSynthesisDecisionPolicy
  implements SynthesisDecisionPolicyPort
{
  constructor(
    private readonly thesisTriggerMinNumeric: number,
    private readonly graceAllowOnSectorWeakness: boolean,
    private readonly formatMetricValue: (metric: MetricPointEntity) => string,
  ) {}

  /**
   * Produces concise business checkpoints from the strongest current-run evidence.
   */
  buildCheckpoints(args: {
    signalPack: SignalPack;
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    metricLabelByName: Map<string, string>;
    filingLabelByFactName: Map<string, string>;
    selectedNewsLabels: string[];
    horizon: "0_4_weeks" | "1_2_quarters" | "1_3_years";
  }): ThesisCheckpoint[] {
    const byMetricName = new Map(
      args.metrics.map((metric) => [metric.metricName, metric]),
    );
    const deadline =
      args.horizon === "0_4_weeks"
        ? "next 0-4 weeks"
        : args.horizon === "1_3_years"
          ? "next 1-3 years"
          : "next 1-2 quarters";

    const metricCheckpoints: ThesisCheckpoint[] = args.signalPack.signals
      .slice()
      .sort(
        (left, right) =>
          Math.abs(right.normalizedValue) - Math.abs(left.normalizedValue),
      )
      .slice(0, 4)
      .flatMap<ThesisCheckpoint>((signal) => {
        const metric = byMetricName.get(signal.metricName);
        const citation = args.metricLabelByName.get(signal.metricName) ?? "M1";
        if (!metric) {
          return [];
        }
        const metricLabel = signal.metricName.replace(/_/g, " ");
        const currentValue = this.formatMetricValue(metric);

        if (signal.direction === "negative") {
          return [
            {
              kind: "falsifies",
              text: `${metricLabel} deteriorates versus current level (${currentValue}).`,
              evidenceRefs: [citation],
              deadline,
            },
          ];
        }
        if (signal.direction === "positive") {
          return [
            {
              kind: "supports",
              text: `${metricLabel} holds or improves from current level (${currentValue}).`,
              evidenceRefs: [citation],
              deadline,
            },
          ];
        }
        return [];
      });

    const filingRisk = args.filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) =>
          fact.name === "mentions_regulatory_action" && fact.value === "true",
      ),
    );
    const filingCheckpoint: ThesisCheckpoint[] = filingRisk
      ? [
          {
            kind: "falsifies",
            text: "Regulatory or legal pressure rises in subsequent filings.",
            evidenceRefs: [
              args.filingLabelByFactName.get("mentions_regulatory_action") ?? "F1",
            ],
            deadline,
          },
        ]
      : [];

    const catalysts: ThesisCheckpoint[] =
      args.selectedNewsLabels.length > 0
        ? [
            {
              kind: "catalyst",
              text: "Company-specific operating updates provide the next confirmation checkpoint.",
              evidenceRefs: [args.selectedNewsLabels[0] ?? "N_issuer1"],
              deadline,
            },
          ]
        : [];

    const supports = metricCheckpoints
      .filter((item) => item.kind === "supports")
      .slice(0, 2);
    const falsifies = [...filingCheckpoint, ...metricCheckpoints.filter((item) => item.kind === "falsifies")].slice(0, 2);
    return [...supports, ...falsifies, ...catalysts.slice(0, 2)].slice(0, 6);
  }

  /**
   * Builds continuous sufficiency diagnostics so weak evidence downgrades action cleanly.
   */
  buildSufficiencyDiagnostics(args: {
    selection: RelevanceSelection;
    signalPack: SignalPack;
    kpiCoverage: KpiCoverageDiagnostics;
    filingsCount: number;
    valuationAvailable: boolean;
    catalystsCount: number;
    falsifiersCount: number;
  }): SufficiencyDiagnostics {
    let score = 25;
    const missingCriticalDimensions: string[] = [];
    const reasonCodes: string[] = [];

    if (args.kpiCoverage.coreRequiredCount > 0) {
      const coreCoverageRatio =
        (args.kpiCoverage.coreCurrentCount + args.kpiCoverage.coreCarriedCount) /
        args.kpiCoverage.coreRequiredCount;
      score += Math.min(30, Math.max(0, coreCoverageRatio) * 30);
      if (coreCoverageRatio < 1) {
        missingCriticalDimensions.push("core_kpi_coverage");
        reasonCodes.push("insufficient_core_kpi_coverage");
      }
    } else {
      score += 18;
    }

    if (args.kpiCoverage.sectorExpectedCount > 0) {
      const sectorCoverageRatio =
        (args.kpiCoverage.sectorCurrentCount + args.kpiCoverage.sectorCarriedCount) /
        args.kpiCoverage.sectorExpectedCount;
      score += Math.min(10, Math.max(0, sectorCoverageRatio) * 10);
      if (sectorCoverageRatio < 0.5) {
        reasonCodes.push("sector_kpi_depth_weak");
      }
    }

    const freshRatio =
      args.signalPack.coverage.totalSignals === 0
        ? 0
        : args.signalPack.coverage.freshSignals /
          args.signalPack.coverage.totalSignals;
    score += freshRatio * 15;
    if (args.signalPack.coverage.totalSignals < this.thesisTriggerMinNumeric) {
      missingCriticalDimensions.push("numeric_signal_coverage");
      reasonCodes.push("insufficient_numeric_signal_coverage");
      score -= 12;
    }
    if (freshRatio < 0.4) {
      reasonCodes.push("signal_freshness_weak");
      score -= 8;
    }

    if (args.filingsCount < 1) {
      missingCriticalDimensions.push("filing_evidence");
      reasonCodes.push("missing_filing_evidence");
      score -= 12;
    } else {
      score += 8;
    }

    if (!args.valuationAvailable) {
      missingCriticalDimensions.push("valuation_context");
      reasonCodes.push("missing_valuation_context");
      score -= 10;
    } else {
      score += 6;
    }

    if (args.catalystsCount + args.falsifiersCount < 1) {
      missingCriticalDimensions.push("actionability");
      reasonCodes.push("missing_actionability");
      score -= 10;
    } else {
      score += 6;
    }

    if (args.selection.lowRelevance) {
      reasonCodes.push("low_issuer_relevance");
      score -= 6;
    }
    if (args.selection.issuerAnchorCount < 1) {
      reasonCodes.push("missing_issuer_anchor");
      score -= 5;
    } else {
      score += Math.min(4, args.selection.issuerAnchorCount * 1.5);
    }

    const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
    const threshold = 55;
    return {
      score: normalizedScore,
      threshold,
      passed:
        normalizedScore >= threshold && missingCriticalDimensions.length === 0,
      missingCriticalDimensions: Array.from(new Set(missingCriticalDimensions)),
      reasonCodes: Array.from(new Set(reasonCodes)).slice(0, 12),
    };
  }

  /**
   * Converts normalized signals into weighted buy/avoid pressure scores.
   */
  deriveDecisionFromSignals(args: {
    signalPack: SignalPack;
    sufficiency: SufficiencyDiagnostics;
    selection: RelevanceSelection;
    filings: FilingEntity[];
  }): {
    decision: "buy" | "watch" | "avoid";
    reasons: string[];
    scoreBreakdown: DecisionScoreBreakdown;
  } {
    const contributions = args.signalPack.signals.slice(0, 10).map((signal) => {
      const weight = this.signalWeight(signal.metricName);
      return {
        signalId: signal.signalId,
        weight,
        normalizedValue: signal.normalizedValue,
        contribution: Number.parseFloat(
          (weight * signal.normalizedValue).toFixed(4),
        ),
      };
    });
    const netScoreRaw = contributions.reduce(
      (sum, contribution) => sum + contribution.contribution,
      0,
    );
    const buyScore = contributions
      .filter((contribution) => contribution.contribution > 0)
      .reduce((sum, contribution) => sum + contribution.contribution, 0);
    const avoidScore = Math.abs(
      contributions
        .filter((contribution) => contribution.contribution < 0)
        .reduce((sum, contribution) => sum + contribution.contribution, 0),
    );

    let netScore = netScoreRaw;
    if (args.selection.lowRelevance) {
      netScore -= 0.2;
    }
    if (
      args.filings.some((filing) =>
        filing.extractedFacts.some(
          (fact) =>
            fact.name === "mentions_regulatory_action" && fact.value === "true",
        ),
      )
    ) {
      netScore -= 0.35;
    }
    if (!args.sufficiency.passed) {
      netScore = this.clamp(netScore, -0.25, 0.25);
    }

    const reasons = args.sufficiency.reasonCodes.slice(0, 6);
    if (netScore >= 0.2) {
      reasons.push("weighted_signals_support_buy");
    } else if (netScore <= -0.2) {
      reasons.push("weighted_signals_support_avoid");
    } else {
      reasons.push("weighted_signals_mixed_watch");
    }

    return {
      decision: netScore >= 0.2 ? "buy" : netScore <= -0.2 ? "avoid" : "watch",
      reasons: Array.from(new Set(reasons)),
      scoreBreakdown: {
        buyScore: Number.parseFloat(buyScore.toFixed(4)),
        avoidScore: Number.parseFloat(avoidScore.toFixed(4)),
        netScore: Number.parseFloat(netScore.toFixed(4)),
        reasonCodes: Array.from(new Set(reasons)).slice(0, 10),
        contributions,
      },
    };
  }

  /**
   * Maps directional seed and sufficiency diagnostics into conservative public action states.
   */
  toActionDecision(
    decision: "buy" | "watch" | "avoid",
    sufficiency: SufficiencyDiagnostics,
    kpiCoverage: KpiCoverageDiagnostics,
  ): ActionDecision {
    if (!sufficiency.passed) {
      const onlySectorWeakness =
        sufficiency.missingCriticalDimensions.length === 0 &&
        sufficiency.reasonCodes.includes("sector_kpi_depth_weak");
      if (
        this.graceAllowOnSectorWeakness &&
        onlySectorWeakness &&
        kpiCoverage.mode === "grace_low_quality"
      ) {
        return "watch";
      }
      return "insufficient_evidence";
    }

    if (
      decision === "buy" &&
      kpiCoverage.coreCurrentCount + kpiCoverage.coreCarriedCount < 3
    ) {
      return "watch";
    }

    return decision;
  }

  /**
   * Derives position sizing from final action decision.
   */
  toPositionSizing(decision: ActionDecision): "none" | "small" | "medium" {
    if (decision === "insufficient_evidence") {
      return "none";
    }
    if (decision === "buy") {
      return "medium";
    }
    return "small";
  }

  /**
   * Converts falsifying checkpoints into structured investor-facing falsification blocks.
   */
  buildFalsification(checkpoints: ThesisCheckpoint[]) {
    return checkpoints
      .filter((item) => item.kind === "falsifies")
      .slice(0, 2)
      .map((item) => ({
        condition: item.text,
        type: /\bmargin|growth|revenue|cash|ratio|percent|%\b/i.test(item.text)
          ? ("numeric" as const)
          : ("event" as const),
        thresholdOrOutcome: "business deterioration confirmed",
        deadline: item.deadline ?? "next 1-2 quarters",
        actionIfHit: "reduce risk exposure",
        evidenceRefs: item.evidenceRefs,
      }));
  }

  /**
   * Encodes metric family importance so weighted scoring emphasizes business durability anchors.
   */
  private signalWeight(metricName: string): number {
    if (/price_to_earnings|peer_pe_premium|ev_to_sales|ev_to_ebit/.test(metricName)) {
      return 0.32;
    }
    if (/revenue_growth|profit_margin|eps/.test(metricName)) {
      return 0.36;
    }
    if (/analyst_buy_ratio|price_return_3m/.test(metricName)) {
      return 0.2;
    }
    if (/volatility|days_to_next/.test(metricName)) {
      return 0.14;
    }
    return 0.16;
  }

  /**
   * Bounds derived directional score after quality penalties.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.parseFloat(value.toFixed(4))));
  }
}

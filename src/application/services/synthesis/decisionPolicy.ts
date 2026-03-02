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
  ActionMatrixRow,
  RelevanceSelection,
  SynthesisDecisionPolicyPort,
} from "./types";

/**
 * Implements deterministic decision scoring so directional output comes from normalized numeric evidence first.
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
   * Builds deterministic trigger rows from highest-impact normalized signals so falsifiers stay specific and auditable.
   */
  buildActionMatrix(
    signalPack: SignalPack,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    metricLabelByName: Map<string, string>,
    filingLabelByFactName: Map<string, string>,
  ): ActionMatrixRow[] {
    const byMetricName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const topSignals = signalPack.signals
      .slice()
      .sort((left, right) => Math.abs(right.normalizedValue) - Math.abs(left.normalizedValue))
      .slice(0, 4);

    const rows: ActionMatrixRow[] = topSignals.flatMap((signal) => {
      const metric = byMetricName.get(signal.metricName);
      if (!metric) {
        return [];
      }

      const currentValue = `${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""}`;
      const threshold = this.deriveThreshold(metric.metricName, metric.metricValue, signal.direction);
      const condition = `If ${metric.metricName.replace(/_/g, " ")} ${signal.direction === "negative" ? "moves above" : "moves below"} ${threshold}`;
      const action =
        signal.direction === "negative"
          ? "then reduce risk exposure"
          : "then add selectively";
      const citation = metricLabelByName.get(metric.metricName) ?? "M1";

      return [
        {
          signalId: signal.signalId,
          label: `${metric.metricName.replace(/_/g, " ")} regime`,
          currentValue,
          condition,
          action,
          citations: [citation],
          hasNumericThreshold: true,
        },
      ];
    });

    const filingRisk = filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) => fact.name === "mentions_regulatory_action" && fact.value === "true",
      ),
    );
    if (filingRisk || filings.length > 0) {
      rows.push({
        signalId: "signal_filing_risk",
        label: "Regulatory filing risk",
        currentValue: filingRisk ? "true" : "false",
        condition: "If mentions_regulatory_action becomes true",
        action: filingRisk ? "then reduce risk exposure" : "then hold size constant",
        citations: [filingLabelByFactName.get("mentions_regulatory_action") ?? "F1"],
        hasNumericThreshold: true,
      });
    }

    const deduped = rows
      .filter((row, index, all) => all.findIndex((item) => item.signalId === row.signalId) === index)
      .slice(0, 5);
    return deduped.length > 0 ? deduped : [
      {
        signalId: "signal_minimum_coverage",
        label: "Signal coverage checkpoint",
        currentValue: `${signalPack.coverage.totalSignals} signals`,
        condition: `If total normalized signals moves below ${this.thesisTriggerMinNumeric}`,
        action: "then re-evaluate decision confidence",
        citations: ["M1"],
        hasNumericThreshold: true,
      },
    ];
  }

  /**
   * Builds continuous sufficiency diagnostics so evidence quality can degrade gracefully instead of hard-failing early.
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
        : args.signalPack.coverage.freshSignals / args.signalPack.coverage.totalSignals;
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
      passed: normalizedScore >= threshold && missingCriticalDimensions.length === 0,
      missingCriticalDimensions: Array.from(new Set(missingCriticalDimensions)),
      reasonCodes: Array.from(new Set(reasonCodes)).slice(0, 12),
    };
  }

  /**
   * Converts normalized signals into weighted buy/avoid pressure scores for deterministic directional seeds.
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
        contribution: Number.parseFloat((weight * signal.normalizedValue).toFixed(4)),
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
    if (args.filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) => fact.name === "mentions_regulatory_action" && fact.value === "true",
      ),
    )) {
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
   * Formats action matrix rows for prompt constraints.
   */
  formatActionMatrix(rows: ActionMatrixRow[]): string {
    return rows
      .map(
        (row, index) =>
          `- T${index + 1} ${row.label}: current=${row.currentValue}; ${row.condition}, ${row.action} (${row.citations.join(", ")})`,
      )
      .join("\n");
  }

  /**
   * Maps directional seed and sufficiency diagnostics into public action states while preserving low-quality watch semantics.
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
        return "watch_low_quality";
      }
      return "insufficient_evidence";
    }

    if (
      this.graceAllowOnSectorWeakness &&
      kpiCoverage.mode === "grace_low_quality" &&
      kpiCoverage.sectorExpectedCount > 0 &&
      kpiCoverage.sectorCurrentCount + kpiCoverage.sectorCarriedCount < 1
    ) {
      return "watch_low_quality";
    }

    return decision;
  }

  /**
   * Derives position sizing from final action decision so downstream consumers can keep portfolio controls deterministic.
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
   * Projects trigger rows into investor-facing falsification blocks without leaking policy internals.
   */
  buildFalsification(actionMatrix: ActionMatrixRow[]) {
    return actionMatrix.slice(0, 3).map((row) => ({
      condition: row.condition,
      type: row.hasNumericThreshold ? "numeric" : "event",
      thresholdOrOutcome: row.currentValue,
      deadline: "next earnings cycle",
      actionIfHit: row.action,
      evidenceRefs: row.citations,
    })) as Array<{
      condition: string;
      type: "numeric" | "event" | "timing";
      thresholdOrOutcome: string;
      deadline: string;
      actionIfHit: string;
      evidenceRefs: string[];
    }>;
  }

  /**
   * Calibrates metric threshold strings from current values so triggers remain symbol-specific instead of static templates.
   */
  private deriveThreshold(
    metricName: string,
    metricValue: number,
    direction: "positive" | "negative" | "neutral",
  ): string {
    const multiplier = direction === "negative" ? 1.1 : 0.9;
    if (/ratio|margin|growth/.test(metricName)) {
      return `${(metricValue * multiplier * 100).toFixed(1)}%`;
    }
    if (/days/.test(metricName)) {
      return `${Math.max(1, Math.round(metricValue * multiplier))} days`;
    }
    return Number.parseFloat((metricValue * multiplier).toFixed(2)).toString();
  }

  /**
   * Encodes metric family importance so weighted scoring emphasizes valuation, growth, and profitability anchors.
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
   * Bounds derived directional score after quality penalties so weak-evidence runs cannot overstate conviction.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.parseFloat(value.toFixed(4))));
  }
}

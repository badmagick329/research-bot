import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type { KpiCoverageDiagnostics } from "../../../core/entities/research";
import type {
  ActionMatrixRow,
  DecisionContext,
  RelevanceSelection,
  SynthesisDecisionPolicyPort,
} from "./types";

/**
 * Implements deterministic action policy so final stance and trigger logic stay auditable and stable.
 */
export class DeterministicSynthesisDecisionPolicy
  implements SynthesisDecisionPolicyPort
{
  constructor(
    private readonly thesisTriggerMinNumeric: number,
    private readonly graceAllowOnSectorWeakness: boolean,
    private readonly formatMetricValue: (metric: MetricPointEntity) => string,
    private readonly isEvidenceWeak: (
      selection: RelevanceSelection,
      metricsCount: number,
      filingsCount: number,
    ) => boolean,
  ) {}

  /**
   * Produces deterministic context flags from evidence for downstream decision policy.
   */
  buildDecisionContext(
    selection: RelevanceSelection,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): DecisionContext {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const pe = byName.get("price_to_earnings")?.metricValue;
    const growthRatio = byName.get("revenue_growth_yoy")?.metricValue;
    const analystSupport =
      (byName.get("analyst_buy_ratio")?.metricValue ?? 0) >= 0.55;

    const filingRiskFlag = filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) =>
          (fact.name === "mentions_risk_factor_change" ||
            fact.name === "mentions_regulatory_action") &&
          fact.value === "true",
      ),
    );

    return {
      evidenceWeak: this.isEvidenceWeak(selection, metrics.length, filings.length),
      lowRelevance: selection.lowRelevance,
      valuationStress: typeof pe === "number" && pe >= 45,
      growthStrength: typeof growthRatio === "number" && growthRatio >= 0.15,
      filingRiskFlag,
      analystSupport,
      issuerAnchorCount: selection.issuerAnchorCount,
    };
  }

  /**
   * Converts deterministic context into a directional seed plus reason codes.
   */
  deriveDecisionFromContext(
    context: DecisionContext,
  ): { decision: "buy" | "watch" | "avoid"; reasons: string[] } {
    const reasons: string[] = [];

    if (context.filingRiskFlag && context.valuationStress) {
      reasons.push("high_valuation_with_filing_risk");
      return { decision: "avoid", reasons };
    }

    if (!context.evidenceWeak && !context.valuationStress && context.growthStrength) {
      if (context.issuerAnchorCount < 2) {
        reasons.push("insufficient_issuer_anchors");
        return { decision: "watch", reasons };
      }
      reasons.push("strong_growth_with_acceptable_valuation");
      if (context.analystSupport) {
        reasons.push("analyst_supportive");
      }
      return { decision: "buy", reasons };
    }

    reasons.push("conservative_default_watch");
    if (context.evidenceWeak) {
      reasons.push("evidence_weak");
    }
    if (context.valuationStress) {
      reasons.push("valuation_stress");
    }

    return { decision: "watch", reasons };
  }

  /**
   * Builds deterministic trigger matrix rows from metric/filing evidence.
   */
  buildActionMatrix(
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    metricLabelByName: Map<string, string>,
    filingLabelByFactName: Map<string, string>,
  ): ActionMatrixRow[] {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const rows: ActionMatrixRow[] = [];
    const metricCitation = (metricName: string): string[] => {
      const label = metricLabelByName.get(metricName);
      return label ? [label] : [];
    };
    const filingCitation = (factName: string): string[] => {
      const label = filingLabelByFactName.get(factName);
      return label ? [label] : [];
    };

    const pe = byName.get("price_to_earnings");
    if (pe) {
      rows.push({
        signalId: "valuation_pe",
        label: "Valuation multiple pressure",
        currentValue: `${this.formatMetricValue(pe)}${pe.metricUnit ? ` ${pe.metricUnit}` : ""}`,
        condition: "If P/E falls below 35 or earnings growth re-accelerates above 20%",
        action: "then upgrade one notch",
        citations: metricCitation("price_to_earnings"),
        hasNumericThreshold: true,
      });
    }

    const growth = byName.get("revenue_growth_yoy");
    if (growth) {
      rows.push({
        signalId: "growth_revenue",
        label: "Top-line momentum",
        currentValue: `${(growth.metricValue * 100).toFixed(1)}%`,
        condition: "If revenue growth stays above 15% for next two quarters",
        action: "then add on strength",
        citations: metricCitation("revenue_growth_yoy"),
        hasNumericThreshold: true,
      });
    }

    const peerPePremium = byName.get("peer_pe_premium_pct");
    if (peerPePremium) {
      rows.push({
        signalId: "valuation_peer_premium",
        label: "Peer valuation premium",
        currentValue: `${peerPePremium.metricValue.toFixed(1)}%`,
        condition: "If peer P/E premium compresses below 10%",
        action: "then add selectively",
        citations: metricCitation("peer_pe_premium_pct"),
        hasNumericThreshold: true,
      });
    }

    const analyst = byName.get("analyst_buy_ratio");
    if (analyst) {
      rows.push({
        signalId: "analyst_support",
        label: "Analyst stance",
        currentValue: `${(analyst.metricValue * 100).toFixed(1)}% buy`,
        condition: "If analyst buy ratio drops below 45%",
        action: "then downgrade one notch",
        citations: metricCitation("analyst_buy_ratio"),
        hasNumericThreshold: true,
      });
    }

    const nextEarnings = byName.get("earnings_event_days_to_next");
    if (nextEarnings) {
      rows.push({
        signalId: "earnings_timing",
        label: "Event timing risk",
        currentValue: `${Math.round(nextEarnings.metricValue)} days`,
        condition: "If next earnings are within 10 days and valuation remains above 45x",
        action: "then hold size constant",
        citations: metricCitation("earnings_event_days_to_next"),
        hasNumericThreshold: true,
      });
    }

    const return3m = byName.get("price_return_3m");
    const volRegime = byName.get("volatility_regime_score");
    if (return3m && volRegime) {
      rows.push({
        signalId: "price_momentum_volatility",
        label: "Momentum versus volatility regime",
        currentValue: `3m return=${return3m.metricValue.toFixed(1)}%, volScore=${volRegime.metricValue.toFixed(1)}`,
        condition: "If 3m return stays above 15% while volatility regime score stays below 45",
        action: "then add on pullbacks",
        citations: [
          ...metricCitation("price_return_3m"),
          ...metricCitation("volatility_regime_score"),
        ],
        hasNumericThreshold: true,
      });
    }

    const filingRisk = filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) =>
          fact.name === "mentions_regulatory_action" && fact.value === "true",
      ),
    );
    rows.push({
      signalId: "filing_risk",
      label: "Regulatory risk signal",
      currentValue: filingRisk ? "true" : "false",
      condition: "If filing risk signals turn true in next disclosure",
      action: "then reduce risk exposure",
      citations: filingCitation("mentions_regulatory_action"),
      hasNumericThreshold: true,
    });

    const filtered = rows
      .map((row) => ({
        ...row,
        citations: row.citations.length > 0 ? row.citations : ["M1"],
      }))
      .slice(0, 5);
    const numericCount = filtered.filter((row) => row.hasNumericThreshold).length;
    if (numericCount < this.thesisTriggerMinNumeric) {
      filtered.push({
        signalId: "insufficient_signal",
        label: "Insufficient numeric signal coverage",
        currentValue: `${numericCount} numeric triggers`,
        condition: `If at least ${this.thesisTriggerMinNumeric} numeric triggers become available`,
        action: "then re-evaluate decision confidence",
        citations: ["M1"],
        hasNumericThreshold: true,
      });
    }

    while (filtered.length < 3) {
      const idx = filtered.length + 1;
      filtered.push({
        signalId: `coverage_fallback_${idx}`,
        label: "Coverage completion trigger",
        currentValue: `${metrics.length} metrics / ${filings.length} filings`,
        condition: `If available metric count reaches ${this.thesisTriggerMinNumeric + 2}`,
        action: "then upgrade confidence one step",
        citations: ["M1"],
        hasNumericThreshold: true,
      });
    }

    return filtered.slice(0, 5);
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
   * Applies Stage-1 evidence floor checks.
   */
  buildEvidenceGate(args: {
    filingsCount: number;
    kpiCoverage: KpiCoverageDiagnostics;
    valuationAvailable: boolean;
    catalystsCount: number;
    falsifiersCount: number;
  }): { passed: boolean; failures: string[]; missingFields: string[] } {
    const failures: string[] = [];
    const missingFields: string[] = [];

    if (args.filingsCount < 1) {
      failures.push("missing_filing_evidence");
      missingFields.push("filings");
    }
    if (
      args.kpiCoverage.coreCurrentCount + args.kpiCoverage.coreCarriedCount <
      args.kpiCoverage.coreRequiredCount
    ) {
      failures.push("insufficient_core_kpi_items");
      missingFields.push("kpis");
    }
    if (
      args.kpiCoverage.sectorExpectedCount > 0 &&
      args.kpiCoverage.sectorCurrentCount + args.kpiCoverage.sectorCarriedCount <
        1
    ) {
      failures.push("low_sector_kpi_quality");
    }
    if (!args.valuationAvailable) {
      failures.push("missing_valuation_context");
      missingFields.push("valuation_context");
    }
    if (args.catalystsCount + args.falsifiersCount < 1) {
      failures.push("missing_catalyst_or_falsifier");
      missingFields.push("catalyst_or_falsifier");
    }

    return {
      passed: failures.length === 0,
      failures,
      missingFields,
    };
  }

  /**
   * Maps policy seed + evidence gate into public action decision.
   */
  toActionDecision(
    decision: "buy" | "watch" | "avoid",
    gate: { passed: boolean; failures: string[] },
    kpiCoverage: KpiCoverageDiagnostics,
  ): "buy" | "watch" | "avoid" | "watch_low_quality" | "insufficient_evidence" {
    const gateFailures = new Set(gate.failures);
    const hasNonKpiFailure = [...gateFailures].some(
      (failure) =>
        failure !== "insufficient_core_kpi_items" &&
        failure !== "low_sector_kpi_quality",
    );
    if (hasNonKpiFailure) {
      return "insufficient_evidence";
    }

    if (gateFailures.has("insufficient_core_kpi_items")) {
      return "insufficient_evidence";
    }

    if (
      this.graceAllowOnSectorWeakness &&
      gateFailures.has("low_sector_kpi_quality") &&
      kpiCoverage.mode === "grace_low_quality"
    ) {
      return "watch_low_quality";
    }

    if (!gate.passed) {
      return "insufficient_evidence";
    }

    if (decision === "buy") {
      return "buy";
    }
    if (decision === "avoid") {
      return "avoid";
    }
    return "watch";
  }

  /**
   * Derives position sizing from final action decision.
   */
  toPositionSizing(
    decision: "buy" | "watch" | "avoid" | "watch_low_quality" | "insufficient_evidence",
  ): "none" | "small" | "medium" {
    if (decision === "insufficient_evidence") {
      return "none";
    }
    if (decision === "buy") {
      return "medium";
    }
    return "small";
  }

  /**
   * Projects action matrix rows into structured falsification conditions.
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
}

import type {
  KpiTemplateContext,
  KpiTemplateName,
  ResearchSnapshotEntity,
  ThesisType,
} from "../../core/entities/research";
import type { JobPayload } from "../../core/ports/outboundPorts";

type KpiTemplate = {
  name: KpiTemplateName;
  required: string[];
  optional: string[];
  minRequiredForStrongNote: number;
};

const kpiTemplates: KpiTemplate[] = [
  {
    name: "software_saas",
    required: ["revenue_growth_yoy", "profit_margin", "eps"],
    optional: [
      "price_to_earnings",
      "analyst_buy_ratio",
      "free_cash_flow_margin",
      "sbc_pct_revenue",
    ],
    minRequiredForStrongNote: 3,
  },
  {
    name: "semis",
    required: ["revenue_growth_yoy", "profit_margin", "gross_margin"],
    optional: [
      "price_to_earnings",
      "analyst_buy_ratio",
      "peer_rev_growth_percentile",
      "volatility_regime_score",
    ],
    minRequiredForStrongNote: 3,
  },
  {
    name: "banks",
    required: ["net_interest_margin", "loan_growth", "cet1_ratio"],
    optional: [
      "deposit_growth",
      "credit_loss_ratio",
      "efficiency_ratio",
      "price_to_book",
    ],
    minRequiredForStrongNote: 3,
  },
  {
    name: "retail_consumer",
    required: ["revenue_growth_yoy", "gross_margin", "inventory_turnover"],
    optional: [
      "same_store_sales",
      "traffic_growth",
      "ticket_growth",
      "price_to_earnings",
    ],
    minRequiredForStrongNote: 3,
  },
  {
    name: "energy_materials",
    required: ["free_cash_flow", "capex", "net_debt_to_ebitda"],
    optional: [
      "production_growth",
      "realized_price",
      "dividend_yield",
      "price_to_earnings",
    ],
    minRequiredForStrongNote: 3,
  },
  {
    name: "generic",
    required: ["revenue_growth_yoy", "price_to_earnings", "eps"],
    optional: ["profit_margin", "analyst_buy_ratio", "market_cap", "price_return_6m"],
    minRequiredForStrongNote: 2,
  },
];

const kpiTemplateByName = new Map(kpiTemplates.map((template) => [template.name, template]));

/**
 * Rebuilds KPI context from snapshot evidence so synthesize-only refresh preserves Stage-1 quality gates without schema changes.
 */
const rebuildKpiContextFromSnapshot = (
  snapshot: ResearchSnapshotEntity,
): KpiTemplateContext | undefined => {
  const selected = Array.from(
    new Set(snapshot.investorViewV2?.keyKpis.map((kpi) => kpi.name) ?? []),
  );
  if (!snapshot.investorViewV2 || selected.length === 0) {
    return undefined;
  }

  const template = resolveTemplate(snapshot, selected);
  const requiredHitCount = template.required.filter((name) =>
    selected.includes(name),
  ).length;

  return {
    template: template.name,
    required: template.required,
    optional: template.optional,
    selected,
    requiredHitCount,
    minRequiredForStrongNote: template.minRequiredForStrongNote,
  };
};

/**
 * Chooses a deterministic KPI template by overlap first, then thesis-type hint, and falls back to generic for sparse insufficient-evidence snapshots.
 */
const resolveTemplate = (
  snapshot: ResearchSnapshotEntity,
  selectedKpiNames: string[],
): KpiTemplate => {
  const selected = new Set(selectedKpiNames);
  const bestByOverlap = kpiTemplates
    .map((template) => ({
      template,
      overlapCount: [...template.required, ...template.optional].filter((name) =>
        selected.has(name),
      ).length,
      requiredOverlap: template.required.filter((name) => selected.has(name)).length,
    }))
    .sort((left, right) => {
      if (right.overlapCount !== left.overlapCount) {
        return right.overlapCount - left.overlapCount;
      }
      return right.requiredOverlap - left.requiredOverlap;
    })[0];

  if (bestByOverlap && bestByOverlap.overlapCount > 0) {
    return bestByOverlap.template;
  }

  const decision = snapshot.investorViewV2?.action.decision;
  if (decision === "insufficient_evidence") {
    return kpiTemplateByName.get("generic") ?? kpiTemplates[kpiTemplates.length - 1]!;
  }

  const templateFromType = mapTemplateFromThesisType(snapshot.investorViewV2?.thesisType);
  if (templateFromType) {
    return kpiTemplateByName.get(templateFromType) ?? kpiTemplates[kpiTemplates.length - 1]!;
  }

  return kpiTemplateByName.get("generic") ?? kpiTemplates[kpiTemplates.length - 1]!;
};

/**
 * Maps thesis type to a template hint so refresh can preserve prior intent when KPI-name overlap is unavailable.
 */
const mapTemplateFromThesisType = (
  thesisType: ThesisType | undefined,
): KpiTemplateName | null => {
  if (thesisType === "compounder") {
    return "software_saas";
  }
  if (thesisType === "cyclical" || thesisType === "turnaround") {
    return "semis";
  }
  return null;
};

/**
 * Builds one synthesize payload from snapshot state so API/CLI refresh paths stay behaviorally identical.
 */
export const buildRefreshThesisPayload = (
  snapshot: ResearchSnapshotEntity,
  normalizedSymbol: string,
  idempotencyKey: string,
): JobPayload => ({
  runId: snapshot.runId ?? "",
  taskId: snapshot.taskId ?? "",
  symbol: normalizedSymbol,
  idempotencyKey,
  requestedAt: new Date().toISOString(),
  resolvedIdentity: snapshot.diagnostics?.identity,
  metricsDiagnostics: snapshot.diagnostics?.metrics,
  metricsCompanyFactsDiagnostics: snapshot.diagnostics?.metricsCompanyFacts,
  providerFailures: snapshot.diagnostics?.providerFailures,
  stageIssues: snapshot.diagnostics?.stageIssues,
  thesisTypeContext: snapshot.investorViewV2
    ? {
        thesisType: snapshot.investorViewV2.thesisType,
        reasonCodes: ["refresh_from_snapshot"],
        score: 50,
      }
    : undefined,
  horizonContext:
    snapshot.horizon === "0_4_weeks" ||
    snapshot.horizon === "1_2_quarters" ||
    snapshot.horizon === "1_3_years"
      ? {
          horizon: snapshot.horizon,
          rationale:
            "Restored from latest snapshot context during synthesize-only refresh.",
          score: 50,
        }
      : undefined,
  kpiContext: rebuildKpiContextFromSnapshot(snapshot),
  evidenceGate: snapshot.diagnostics?.evidenceGate,
});

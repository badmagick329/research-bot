import type {
  KpiTemplateName,
  ResearchSnapshotEntity,
  ThesisType,
} from "../../../core/entities/research";

export type KpiTemplate = {
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
    optional: [
      "profit_margin",
      "analyst_buy_ratio",
      "market_cap",
      "price_return_6m",
    ],
    minRequiredForStrongNote: 2,
  },
];

const kpiTemplateByName = new Map(
  kpiTemplates.map((template) => [template.name, template]),
);

/**
 * Returns all supported KPI templates so application services can share one deterministic catalog.
 */
export const listKpiTemplates = (): KpiTemplate[] => kpiTemplates;

/**
 * Resolves a template by name and falls back to generic to keep pipeline behavior deterministic.
 */
export const getKpiTemplate = (name: KpiTemplateName): KpiTemplate =>
  kpiTemplateByName.get(name) ?? getDefaultKpiTemplate();

/**
 * Returns the generic fallback template used whenever no stronger mapping is available.
 */
export const getDefaultKpiTemplate = (): KpiTemplate =>
  kpiTemplateByName.get("generic") ?? kpiTemplates[kpiTemplates.length - 1]!;

/**
 * Maps thesis type hints into KPI template hints so sparse contexts preserve original strategy intent.
 */
export const mapTemplateFromThesisType = (
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
 * Chooses the strongest template by KPI overlap first, then uses snapshot intent hints as fallback.
 */
export const resolveTemplateFromSnapshot = (
  snapshot: ResearchSnapshotEntity,
  selectedKpiNames: string[],
): KpiTemplate => {
  const selected = new Set(selectedKpiNames);
  const bestByOverlap = listKpiTemplates()
    .map((template) => ({
      template,
      overlapCount: [...template.required, ...template.optional].filter((name) =>
        selected.has(name),
      ).length,
      requiredOverlap: template.required.filter((name) => selected.has(name))
        .length,
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
    return getDefaultKpiTemplate();
  }

  const templateFromType = mapTemplateFromThesisType(
    snapshot.investorViewV2?.thesisType,
  );
  if (templateFromType) {
    return getKpiTemplate(templateFromType);
  }

  return getDefaultKpiTemplate();
};

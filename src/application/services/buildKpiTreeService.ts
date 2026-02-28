import type { DocumentEntity } from "../../core/entities/document";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { KpiTemplateContext, KpiTemplateName } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

type KpiTemplate = {
  name: KpiTemplateName;
  required: string[];
  optional: string[];
  minRequiredForStrongNote: number;
};

/**
 * Builds deterministic KPI template context so synthesis focuses on business-model-relevant checkpoints.
 */
export class BuildKpiTreeService {
  private readonly templates: KpiTemplate[] = [
    {
      name: "software_saas",
      required: ["revenue_growth_yoy", "profit_margin", "eps"],
      optional: ["price_to_earnings", "analyst_buy_ratio", "free_cash_flow_margin", "sbc_pct_revenue"],
      minRequiredForStrongNote: 3,
    },
    {
      name: "semis",
      required: ["revenue_growth_yoy", "profit_margin", "gross_margin"],
      optional: ["price_to_earnings", "analyst_buy_ratio", "peer_rev_growth_percentile", "volatility_regime_score"],
      minRequiredForStrongNote: 3,
    },
    {
      name: "banks",
      required: ["net_interest_margin", "loan_growth", "cet1_ratio"],
      optional: ["deposit_growth", "credit_loss_ratio", "efficiency_ratio", "price_to_book"],
      minRequiredForStrongNote: 3,
    },
    {
      name: "retail_consumer",
      required: ["revenue_growth_yoy", "gross_margin", "inventory_turnover"],
      optional: ["same_store_sales", "traffic_growth", "ticket_growth", "price_to_earnings"],
      minRequiredForStrongNote: 3,
    },
    {
      name: "energy_materials",
      required: ["free_cash_flow", "capex", "net_debt_to_ebitda"],
      optional: ["production_growth", "realized_price", "dividend_yield", "price_to_earnings"],
      minRequiredForStrongNote: 3,
    },
    {
      name: "generic",
      required: ["revenue_growth_yoy", "price_to_earnings", "eps"],
      optional: ["profit_margin", "analyst_buy_ratio", "market_cap", "price_return_6m"],
      minRequiredForStrongNote: 2,
    },
  ];

  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Produces KPI coverage context and forwards payload to embedding stage without changing evidence persistence contracts.
   */
  async run(payload: JobPayload): Promise<void> {
    const [docs, metrics] = await Promise.all([
      this.documentRepo.listBySymbol(payload.symbol, 20, payload.runId),
      this.metricsRepo.listBySymbol(payload.symbol, 40, payload.runId),
    ]);

    const template = this.selectTemplate(payload, docs);
    const metricNames = new Set(metrics.map((metric) => metric.metricName));
    const selected = [...template.required, ...template.optional].filter((name) =>
      metricNames.has(name),
    );
    const requiredHitCount = template.required.filter((name) => metricNames.has(name)).length;

    const kpiContext: KpiTemplateContext = {
      template: template.name,
      required: template.required,
      optional: template.optional,
      selected,
      requiredHitCount,
      minRequiredForStrongNote: template.minRequiredForStrongNote,
    };

    await this.queue.enqueue("embed", {
      ...payload,
      kpiContext,
    });
  }

  /**
   * Selects a KPI template from thesis type plus evidence language so required KPI gates remain domain-oriented.
   */
  private selectTemplate(payload: JobPayload, docs: DocumentEntity[]): KpiTemplate {
    const type = payload.thesisTypeContext?.thesisType ?? "unclear";
    const text = docs.map((doc) => `${doc.title} ${doc.summary ?? ""}`).join(" ").toLowerCase();

    if (type === "compounder" && /(software|cloud|subscription|saas)/.test(text)) {
      return this.lookup("software_saas");
    }

    if (/(semiconductor|gpu|fab|wafer|foundry|chip)/.test(text)) {
      return this.lookup("semis");
    }

    if (/(bank|lender|deposit|loan|credit)/.test(text)) {
      return this.lookup("banks");
    }

    if (/(retail|consumer|store|traffic|basket)/.test(text)) {
      return this.lookup("retail_consumer");
    }

    if (/(oil|gas|mining|commodity|reserves)/.test(text)) {
      return this.lookup("energy_materials");
    }

    if (type === "cyclical" || type === "turnaround") {
      return this.lookup("semis");
    }

    return this.lookup("generic");
  }

  /**
   * Resolves template by name so selection logic stays readable and template defaults remain centralized.
   */
  private lookup(name: KpiTemplateName): KpiTemplate {
    return this.templates.find((template) => template.name === name) ?? this.templates[this.templates.length - 1]!;
  }
}


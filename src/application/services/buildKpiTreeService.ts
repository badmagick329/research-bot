import type { DocumentEntity } from "../../core/entities/document";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { KpiTemplateContext, SelectedKpi } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";
import {
  getKpiTemplate,
  type KpiTemplate,
} from "./shared/kpiCatalog";

/**
 * Builds deterministic KPI template context so synthesis focuses on business-model-relevant checkpoints.
 */
export class BuildKpiTreeService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Produces a focused KPI context so synthesis prioritizes 3-5 business-relevant checkpoints instead of broad metric lists.
   */
  async run(payload: JobPayload): Promise<void> {
    const [docs, metrics] = await Promise.all([
      this.documentRepo.listBySymbol(payload.symbol, 20, payload.runId),
      this.metricsRepo.listBySymbol(payload.symbol, 40, payload.runId),
    ]);

    const template = this.selectTemplate(payload, docs);
    const metricNames = new Set(metrics.map((metric) => metric.metricName));
    const selected = [...template.required, ...template.optional].filter((name) => metricNames.has(name));
    const requiredHitCount = template.required.filter((name) => metricNames.has(name)).length;
    const selectedKpis = this.selectInvestorKpis(metrics, selected);

    const kpiContext: KpiTemplateContext = {
      template: template.name,
      required: template.required,
      optional: template.optional,
      selected: selectedKpis.map((kpi) => kpi.key),
      selectedKpis,
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
      return getKpiTemplate("software_saas");
    }

    if (/(semiconductor|gpu|fab|wafer|foundry|chip)/.test(text)) {
      return getKpiTemplate("semis");
    }

    if (/(bank|lender|deposit|loan|credit)/.test(text)) {
      return getKpiTemplate("banks");
    }

    if (/(retail|consumer|store|traffic|basket)/.test(text)) {
      return getKpiTemplate("retail_consumer");
    }

    if (/(oil|gas|mining|commodity|reserves)/.test(text)) {
      return getKpiTemplate("energy_materials");
    }

    if (type === "cyclical" || type === "turnaround") {
      return getKpiTemplate("semis");
    }

    return getKpiTemplate("generic");
  }

  /**
   * Selects investor-facing KPI slots with a minimum business-quality floor so valuation-only mixes cannot dominate notes.
   */
  private selectInvestorKpis(
    metrics: MetricPointEntity[],
    candidateNames: string[],
  ): SelectedKpi[] {
    const metricByName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const valuation = new Set(["price_to_earnings", "price_to_book", "market_cap", "ev_to_sales", "ev_to_ebit"]);
    const categorize = (name: string): SelectedKpi["category"] => {
      if (/revenue|growth|bookings|backlog/.test(name)) {
        return "growth";
      }
      if (/margin|operating_leverage|gross/.test(name)) {
        return "margin";
      }
      if (/cash|fcf|free_cash_flow|operating_cash/.test(name)) {
        return "cashflow";
      }
      if (/debt|leverage|liquidity|inventory/.test(name)) {
        return "balance_sheet";
      }
      if (/segment|aws|advertising|cloud/.test(name)) {
        return "segment";
      }
      if (valuation.has(name)) {
        return "valuation";
      }
      return "quality";
    };

    const scored = candidateNames
      .flatMap((name) => {
        const metric = metricByName.get(name);
        if (!metric) {
          return [];
        }
        const category = categorize(name);
        const businessWeight = category === "valuation" ? 1 : 4;
        const providerWeight = metric.provider.includes("sec-companyfacts") ? 3 : 1;
        const asOfWeight = Math.max(
          0,
          2 - Math.floor((Date.now() - metric.asOf.getTime()) / (1000 * 60 * 60 * 24 * 90)),
        );
        return [{
          score: businessWeight + providerWeight + asOfWeight,
          item: {
            key: name,
            value: Number.isFinite(metric.metricValue) ? metric.metricValue : null,
            source: metric.provider,
            relevanceReason: `${name.replace(/_/g, " ")} is a direct checkpoint for business durability over the chosen horizon.`,
            category,
          } satisfies SelectedKpi,
        }];
      })
      .sort((left, right) => right.score - left.score);

    const selected = scored.map((entry) => entry.item).slice(0, 5);
    const businessCount = selected.filter((kpi) => kpi.category !== "valuation").length;
    if (businessCount >= 2) {
      return selected.slice(0, Math.max(3, Math.min(5, selected.length)));
    }

    const businessFallback = scored
      .map((entry) => entry.item)
      .filter((kpi) => kpi.category !== "valuation")
      .slice(0, 2);
    const valuationFallback = scored
      .map((entry) => entry.item)
      .filter((kpi) => kpi.category === "valuation")
      .slice(0, 3);
    return [...businessFallback, ...valuationFallback].slice(0, 5);
  }
}


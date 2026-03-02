import type { DocumentEntity } from "../../core/entities/document";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { KpiTemplateContext } from "../../core/entities/research";
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
}


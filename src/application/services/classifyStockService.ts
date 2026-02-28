import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { DocumentEntity } from "../../core/entities/document";
import type { ThesisType, ThesisTypeContext } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

/**
 * Classifies thesis type before synthesis so downstream prompts and gating use deterministic business-shape context.
 */
export class ClassifyStockService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly filingsRepo: FilingsRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Assigns one thesis type using deterministic evidence signals to avoid prompt-only drift across runs.
   */
  async run(payload: JobPayload): Promise<void> {
    const [docs, metrics, filings] = await Promise.all([
      this.documentRepo.listBySymbol(payload.symbol, 20, payload.runId),
      this.metricsRepo.listBySymbol(payload.symbol, 30, payload.runId),
      this.filingsRepo.listBySymbol(payload.symbol, 10, payload.runId),
    ]);
    const context = this.classify(docs, metrics, filings);
    await this.queue.enqueue("select_horizon", {
      ...payload,
      thesisTypeContext: context,
    });
  }

  /**
   * Converts evidence mix into a stable thesis-type classification plus explainable reason codes.
   */
  private classify(
    docs: DocumentEntity[],
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): ThesisTypeContext {
    const reasonCodes: string[] = [];
    const metricByName = new Map(metrics.map((metric) => [metric.metricName, metric]));

    const growth = metricByName.get("revenue_growth_yoy")?.metricValue ?? 0;
    const margin = metricByName.get("profit_margin")?.metricValue ?? 0;
    const pe = metricByName.get("price_to_earnings")?.metricValue ?? 0;
    const analystBuyRatio = metricByName.get("analyst_buy_ratio")?.metricValue ?? 0;

    const corpus = `${docs.map((doc) => `${doc.title} ${doc.summary ?? ""} ${doc.content}`).join(" ")} ${filings
      .flatMap((filing) => filing.extractedFacts.map((fact) => `${fact.name}=${fact.value}`))
      .join(" ")}`.toLowerCase();

    if (/(investigation|litigation|merger|acquisition|approval|court|settlement)/.test(corpus)) {
      reasonCodes.push("event_window");
      return {
        thesisType: "event_driven",
        reasonCodes,
        score: 78,
      };
    }

    if (growth >= 0.12 && margin >= 0.18 && pe >= 30) {
      reasonCodes.push("high_growth_high_margin");
      return {
        thesisType: "compounder",
        reasonCodes,
        score: 82,
      };
    }

    if (pe > 0 && pe <= 12 && growth < 0.05 && margin < 0.08) {
      reasonCodes.push("deep_value_low_quality");
      return {
        thesisType: "value_trap_risk",
        reasonCodes,
        score: 72,
      };
    }

    if (/(inventory|backlog|channel|order|downcycle|utilization)/.test(corpus)) {
      reasonCodes.push("cyclical_language");
      return {
        thesisType: "cyclical",
        reasonCodes,
        score: 68,
      };
    }

    if (analystBuyRatio >= 0.7 && growth > 0.08) {
      reasonCodes.push("revision_supported_growth");
      return {
        thesisType: "compounder",
        reasonCodes,
        score: 64,
      };
    }

    if (filings.length === 0 && metrics.length < 3) {
      reasonCodes.push("weak_evidence");
      return {
        thesisType: "unclear",
        reasonCodes,
        score: 35,
      };
    }

    reasonCodes.push("mixed_profile");
    return {
      thesisType: "unclear",
      reasonCodes,
      score: 50,
    };
  }
}


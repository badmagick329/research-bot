import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type {
  JobPayload,
  QueuePort,
  DocumentRepositoryPort,
  MetricsRepositoryPort,
  FilingsRepositoryPort,
  IdGeneratorPort,
  ClockPort,
} from "../../core/ports/outboundPorts";
import type {
  NewsProviderPort,
  MarketMetricsProviderPort,
  FilingsProviderPort,
} from "../../core/ports/inboundPorts";

/**
 * Keeps provider IO at the pipeline edge so downstream stages always consume normalized persisted records.
 */
export class IngestionService {
  constructor(
    private readonly newsProvider: NewsProviderPort,
    private readonly metricsProvider: MarketMetricsProviderPort,
    private readonly filingsProvider: FilingsProviderPort,
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly filingsRepo: FilingsRepositoryPort,
    private readonly queue: QueuePort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly newsLookbackDays: number,
    private readonly filingsLookbackDays: number,
  ) {}

  /**
   * Seeds the pipeline with latest symbol evidence so later stages can stay deterministic and replayable.
   */
  async run(payload: JobPayload): Promise<void> {
    const now = this.clock.now();
    const newsFrom = new Date(
      now.getTime() - this.newsLookbackDays * 24 * 60 * 60 * 1000,
    );
    const filingsFrom = new Date(
      now.getTime() - this.filingsLookbackDays * 24 * 60 * 60 * 1000,
    );

    const [news, metrics, filings] = await Promise.all([
      this.newsProvider.fetchArticles({
        symbol: payload.symbol,
        from: newsFrom,
        to: now,
        limit: 50,
      }),
      this.metricsProvider.fetchMetrics({ symbol: payload.symbol, asOf: now }),
      this.filingsProvider.fetchFilings({
        symbol: payload.symbol,
        from: filingsFrom,
        to: now,
        limit: 10,
      }),
    ]);

    const documents: DocumentEntity[] = news.map((item) => ({
      id: this.ids.next(),
      symbol: payload.symbol,
      provider: item.provider,
      providerItemId: item.providerItemId,
      type: "news",
      title: item.title,
      summary: item.summary,
      content: item.content,
      url: item.url,
      publishedAt: item.publishedAt,
      language: item.language,
      topics: item.topics,
      sourceType: item.sourceType,
      rawPayload: item.rawPayload,
      createdAt: now,
    }));

    const metricEntities: MetricPointEntity[] = metrics.map((item) => ({
      id: this.ids.next(),
      symbol: payload.symbol,
      provider: item.provider,
      metricName: item.metricName,
      metricValue: item.metricValue,
      metricUnit: item.metricUnit,
      currency: item.currency,
      asOf: item.asOf,
      periodType: item.periodType,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd,
      confidence: item.confidence,
      rawPayload: item.rawPayload,
      createdAt: now,
    }));

    const filingEntities: FilingEntity[] = filings.map((item) => ({
      id: this.ids.next(),
      symbol: payload.symbol,
      provider: item.provider,
      issuerName: item.issuerName,
      filingType: item.filingType,
      accessionNo: item.accessionNo,
      filedAt: item.filedAt,
      periodEnd: item.periodEnd,
      docUrl: item.docUrl,
      sections: item.sections,
      extractedFacts: item.extractedFacts,
      rawPayload: item.rawPayload,
      createdAt: now,
    }));

    await Promise.all([
      this.documentRepo.upsertMany(documents),
      this.metricsRepo.upsertMany(metricEntities),
      this.filingsRepo.upsertMany(filingEntities),
    ]);

    await this.queue.enqueue("normalize", payload);
  }
}

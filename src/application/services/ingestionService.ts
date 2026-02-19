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
  MetricsFetchResult,
  NewsProviderPort,
  MarketMetricsProviderPort,
  FilingsProviderPort,
} from "../../core/ports/inboundPorts";
import type { Result } from "neverthrow";
import type { AppBoundaryError } from "../../core/entities/appError";
import type {
  SnapshotProviderFailureDiagnostics,
  SnapshotProviderFailureStatus,
} from "../../core/entities/research";

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
   * Prefers provider-native accession identity and falls back to symbol-scoped document URL identity.
   */
  private buildFilingDedupeKey(
    symbol: string,
    accessionNo: string | undefined,
    docUrl: string,
  ): string {
    const normalizedAccession = accessionNo?.trim();
    if (normalizedAccession) {
      return `accession:${normalizedAccession}`;
    }

    return `doc:${symbol.toUpperCase()}|${docUrl.trim().toLowerCase()}`;
  }

  /**
   * Converts boundary provider failures into snapshot diagnostics so degraded runs remain explicit downstream.
   */
  private toProviderFailure(
    source: "news" | "metrics" | "filings",
    error: AppBoundaryError,
  ): SnapshotProviderFailureDiagnostics {
    return {
      source,
      provider: error.provider,
      status: this.mapFailureStatus(error),
      itemCount: 0,
      reason: error.message,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
    };
  }

  /**
   * Narrows boundary error codes to persisted provider failure statuses for stable snapshot diagnostics.
   */
  private mapFailureStatus(
    error: AppBoundaryError,
  ): SnapshotProviderFailureStatus {
    switch (error.code) {
      case "rate_limited":
      case "timeout":
      case "provider_error":
      case "auth_invalid":
      case "config_invalid":
      case "malformed_response":
      case "transport_error":
      case "invalid_json":
        return error.code;
      case "validation_error":
      case "dimension_mismatch":
      default:
        return "provider_error";
    }
  }

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

    const [newsResult, metricsResult, filingsResult] = await Promise.all([
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

    const sourceResults: Array<Result<unknown, AppBoundaryError>> = [
      newsResult,
      metricsResult,
      filingsResult,
    ];

    const successfulSources = sourceResults.filter((result) => result.isOk());
    if (successfulSources.length === 0) {
      throw new Error(
        `Ingestion failed for ${payload.symbol}: all evidence sources returned errors.`,
      );
    }

    const news = newsResult.isOk() ? newsResult.value : [];

    const providerFailures: SnapshotProviderFailureDiagnostics[] = [];
    if (newsResult.isErr()) {
      providerFailures.push(this.toProviderFailure("news", newsResult.error));
    }

    const fallbackMetrics: MetricsFetchResult = {
      metrics: [],
      diagnostics: {
        provider: "metrics-boundary",
        symbol: payload.symbol,
        status: "provider_error",
        metricCount: 0,
        reason: metricsResult.isErr()
          ? metricsResult.error.message
          : "Metrics provider returned no diagnostics.",
      },
    };

    const metricsPayload = metricsResult.isOk()
      ? metricsResult.value
      : fallbackMetrics;
    const metrics = metricsPayload.metrics;

    if (metricsResult.isErr()) {
      providerFailures.push(
        this.toProviderFailure("metrics", metricsResult.error),
      );
    }

    const filings = filingsResult.isOk() ? filingsResult.value : [];
    if (filingsResult.isErr()) {
      providerFailures.push(
        this.toProviderFailure("filings", filingsResult.error),
      );
    }

    const documents: DocumentEntity[] = news.map((item) => ({
      id: this.ids.next(),
      runId: payload.runId,
      taskId: payload.taskId,
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
      runId: payload.runId,
      taskId: payload.taskId,
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
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      provider: item.provider,
      dedupeKey: this.buildFilingDedupeKey(
        payload.symbol,
        item.accessionNo,
        item.docUrl,
      ),
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

    await this.queue.enqueue("normalize", {
      ...payload,
      metricsDiagnostics: {
        provider: metricsPayload.diagnostics.provider,
        status: metricsPayload.diagnostics.status,
        metricCount: metricsPayload.diagnostics.metricCount,
        reason: metricsPayload.diagnostics.reason,
        httpStatus: metricsPayload.diagnostics.httpStatus,
      },
      providerFailures,
    });
  }
}

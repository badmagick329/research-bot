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
  CompanyFactsProviderPort,
  MetricsFetchResult,
  MarketContextFetchResult,
  MarketContextProviderPort,
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
import { ok } from "neverthrow";

const noopMarketContextProvider: MarketContextProviderPort = {
  fetchMarketContext: async (request) =>
    ok({
      peerRelativeValuation: [],
      earningsGuidance: [],
      analystTrend: [],
      priceContext: [],
      diagnostics: {
        provider: "market-context-disabled",
        symbol: request.symbol,
        status: "empty",
        itemCounts: {
          peerRelativeValuation: 0,
          earningsGuidance: 0,
          analystTrend: 0,
          priceContext: 0,
        },
      },
    }),
};

const noopCompanyFactsProvider: CompanyFactsProviderPort = {
  fetchCompanyFacts: async (request) =>
    ok({
      metrics: [],
      diagnostics: {
        provider: "sec-companyfacts-disabled",
        symbol: request.symbol,
        status: "empty",
        metricCount: 0,
      },
    }),
};

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
    private readonly marketContextProvider: MarketContextProviderPort = noopMarketContextProvider,
    private readonly companyFactsProvider: CompanyFactsProviderPort = noopCompanyFactsProvider,
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
    source: "news" | "metrics" | "filings" | "market-context",
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
   * Enforces explicit hard-failure semantics when Alpha Vantage quota/rate limits are encountered.
   */
  private isAlphaVantageRateLimited(error: AppBoundaryError): boolean {
    return error.provider === "alphavantage" && error.code === "rate_limited";
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

    const [
      newsResult,
      metricsResult,
      filingsResult,
      marketContextResult,
      companyFactsResult,
    ] =
      await Promise.all([
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
      this.marketContextProvider.fetchMarketContext({
        symbol: payload.symbol,
        asOf: now,
      }),
      this.companyFactsProvider.fetchCompanyFacts({
        symbol: payload.symbol,
        asOf: now,
      }),
    ]);

    const sourceResults: Array<Result<unknown, AppBoundaryError>> = [
      newsResult,
      metricsResult,
      filingsResult,
    ];
    if (
      !(
        companyFactsResult.isOk() &&
        companyFactsResult.value.diagnostics.provider ===
          "sec-companyfacts-disabled"
      )
    ) {
      sourceResults.push(companyFactsResult);
    }

    const alphaVantageRateLimitedSources: string[] = [];
    if (
      newsResult.isErr() &&
      this.isAlphaVantageRateLimited(newsResult.error)
    ) {
      alphaVantageRateLimitedSources.push("news");
    }

    if (
      metricsResult.isErr() &&
      this.isAlphaVantageRateLimited(metricsResult.error)
    ) {
      alphaVantageRateLimitedSources.push("metrics");
    }

    if (alphaVantageRateLimitedSources.length > 0) {
      throw new Error(
        `Ingestion failed for ${payload.symbol}: Alpha Vantage rate limit hit (${alphaVantageRateLimitedSources.join(
          ", ",
        )}).`,
      );
    }

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

    const fallbackCompanyFacts: MetricsFetchResult = {
      metrics: [],
      diagnostics: {
        provider: "sec-companyfacts",
        symbol: payload.symbol,
        status: "provider_error",
        metricCount: 0,
        reason: companyFactsResult.isErr()
          ? companyFactsResult.error.message
          : "Companyfacts provider returned no diagnostics.",
      },
    };
    const companyFactsPayload = companyFactsResult.isOk()
      ? companyFactsResult.value
      : fallbackCompanyFacts;
    const companyFactsMetrics = companyFactsPayload.metrics;
    if (companyFactsResult.isErr()) {
      providerFailures.push(
        this.toProviderFailure("metrics", companyFactsResult.error),
      );
    }

    const filings = filingsResult.isOk() ? filingsResult.value : [];
    if (filingsResult.isErr()) {
      providerFailures.push(
        this.toProviderFailure("filings", filingsResult.error),
      );
    }

    const marketContextPayload: MarketContextFetchResult | null =
      marketContextResult.isOk() ? marketContextResult.value : null;
    if (marketContextResult.isErr()) {
      providerFailures.push(
        this.toProviderFailure("market-context", marketContextResult.error),
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

    const marketContextMetrics: MetricPointEntity[] = [
      ...(marketContextPayload?.peerRelativeValuation ?? []),
      ...(marketContextPayload?.earningsGuidance ?? []),
      ...(marketContextPayload?.analystTrend ?? []),
      ...(marketContextPayload?.priceContext ?? []),
    ].map((item) => ({
      id: this.ids.next(),
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      provider: marketContextPayload?.diagnostics.provider ?? "finnhub-market-context",
      metricName: item.metricName,
      metricValue: item.metricValue,
      metricUnit: item.metricUnit,
      currency: "USD",
      asOf: item.asOf,
      periodType: "point_in_time" as const,
      periodStart: undefined,
      periodEnd: undefined,
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

    const marketContextSignals = [
      ...(marketContextPayload?.peerRelativeValuation ?? []),
      ...(marketContextPayload?.earningsGuidance ?? []),
      ...(marketContextPayload?.analystTrend ?? []),
      ...(marketContextPayload?.priceContext ?? []),
    ];

    const marketContextDocuments: DocumentEntity[] = marketContextSignals.map((item, index) => ({
      id: this.ids.next(),
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      provider: marketContextPayload?.diagnostics.provider ?? "finnhub-market-context",
      providerItemId: `${payload.symbol}-${item.metricName}-${item.asOf.toISOString()}-${index}`,
      type: "analysis",
      title: `Market context ${item.metricName}`,
      summary: `${item.metricName}=${item.metricValue.toFixed(4)}`,
      content: `${item.metricName}=${item.metricValue.toFixed(4)}${item.metricUnit ? ` ${item.metricUnit}` : ""}`,
      url: "",
      publishedAt: item.asOf,
      language: "en",
      topics: ["market-context", item.metricName],
      sourceType: "api",
      rawPayload: item.rawPayload,
      createdAt: now,
    }));

    await Promise.all([
      this.documentRepo.upsertMany([...documents, ...marketContextDocuments]),
      this.metricsRepo.upsertMany([
        ...metricEntities,
        ...companyFactsMetrics.map((item) => ({
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
        })),
        ...marketContextMetrics,
      ]),
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
      metricsCompanyFactsDiagnostics: {
        provider: companyFactsPayload.diagnostics.provider,
        status: companyFactsPayload.diagnostics.status,
        metricCount: companyFactsPayload.diagnostics.metricCount,
        reason: companyFactsPayload.diagnostics.reason,
        httpStatus: companyFactsPayload.diagnostics.httpStatus,
      },
      providerFailures,
    });
  }
}

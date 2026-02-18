import { describe, expect, it } from "bun:test";
import { IngestionService } from "./ingestionService";
import type {
  FilingsProviderPort,
  MarketMetricsProviderPort,
  NewsProviderPort,
  FilingsRequest,
  MetricsRequest,
  NewsSearchRequest,
} from "../../core/ports/inboundPorts";
import type {
  ClockPort,
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  IdGeneratorPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "TTWO",
  idempotencyKey: "ttwo-ingest-hour",
  requestedAt: "2026-02-18T00:00:00.000Z",
};

describe("IngestionService", () => {
  it("uses separate lookback windows for news and filings", async () => {
    let capturedNewsRequest: NewsSearchRequest | undefined;
    let capturedMetricsRequest: MetricsRequest | undefined;
    let capturedFilingsRequest: FilingsRequest | undefined;

    const newsProvider: NewsProviderPort = {
      fetchArticles: async (request) => {
        capturedNewsRequest = request;
        return [
          {
            id: "news-1",
            provider: "finnhub",
            providerItemId: "fh-1",
            title: "TTWO headline",
            summary: "Summary",
            content: "Content",
            url: "https://example.com/news-1",
            authors: ["Reporter"],
            publishedAt: now,
            language: "en",
            symbols: ["TTWO"],
            topics: ["ownership"],
            sentiment: 0.1,
            sourceType: "api",
            rawPayload: {},
          },
        ];
      },
    };

    const metricsProvider: MarketMetricsProviderPort = {
      fetchMetrics: async (request) => {
        capturedMetricsRequest = request;
        return [];
      },
    };

    const filingsProvider: FilingsProviderPort = {
      fetchFilings: async (request) => {
        capturedFilingsRequest = request;
        return [
          {
            id: "filing-1",
            provider: "sec-edgar",
            symbol: "TTWO",
            issuerName: "Take-Two Interactive Software, Inc.",
            filingType: "10-Q",
            accessionNo: "0000000000-26-000001",
            filedAt: now,
            periodEnd: undefined,
            docUrl: "https://sec.example/filing-1",
            sections: [],
            extractedFacts: [],
            rawPayload: {},
          },
        ];
      },
    };

    let upsertedDocumentRunId: string | undefined;
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async (documents) => {
        upsertedDocumentRunId = documents.at(0)?.runId;
      },
      listBySymbol: async () => [],
    };

    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    let upsertedFilingDedupeKey: string | undefined;
    let upsertedFilingRunId: string | undefined;
    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async (filings) => {
        upsertedFilingDedupeKey = filings.at(0)?.dedupeKey;
        upsertedFilingRunId = filings.at(0)?.runId;
      },
      listBySymbol: async () => [],
    };

    let queuedPayload: JobPayload | undefined;
    const queue: QueuePort = {
      enqueue: async (_stage, nextPayload) => {
        queuedPayload = nextPayload;
      },
    };

    const now = new Date("2026-02-18T12:00:00.000Z");
    const clock: ClockPort = {
      now: () => now,
    };

    const ids: IdGeneratorPort = {
      next: () => "id-1",
    };

    const service = new IngestionService(
      newsProvider,
      metricsProvider,
      filingsProvider,
      documentRepo,
      metricsRepo,
      filingsRepo,
      queue,
      clock,
      ids,
      7,
      90,
    );

    await service.run(payload);

    expect(capturedNewsRequest).toBeDefined();
    expect(capturedMetricsRequest).toBeDefined();
    expect(capturedFilingsRequest).toBeDefined();

    expect(capturedNewsRequest?.symbol).toBe("TTWO");
    expect(capturedNewsRequest?.to.toISOString()).toBe(now.toISOString());
    expect(capturedNewsRequest?.from.toISOString()).toBe(
      "2026-02-11T12:00:00.000Z",
    );

    expect(capturedFilingsRequest?.symbol).toBe("TTWO");
    expect(capturedFilingsRequest?.to.toISOString()).toBe(now.toISOString());
    expect(capturedFilingsRequest?.from.toISOString()).toBe(
      "2025-11-20T12:00:00.000Z",
    );

    expect(capturedMetricsRequest?.symbol).toBe("TTWO");
    expect(capturedMetricsRequest?.asOf?.toISOString()).toBe(now.toISOString());
    expect(upsertedDocumentRunId).toBe("run-1");
    expect(upsertedFilingRunId).toBe("run-1");
    expect(upsertedFilingDedupeKey).toBe("accession:0000000000-26-000001");
    expect(queuedPayload?.runId).toBe("run-1");
  });
});

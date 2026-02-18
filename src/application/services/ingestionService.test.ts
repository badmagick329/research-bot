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
        return [];
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
        return [];
      },
    };

    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    const queue: QueuePort = {
      enqueue: async () => {},
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
  });
});

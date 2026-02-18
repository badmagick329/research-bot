import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import type {
  FilingsProviderPort,
  MarketMetricsProviderPort,
  NewsProviderPort,
} from "../../core/ports/inboundPorts";
import type {
  ClockPort,
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  IdGeneratorPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
  LlmPort,
} from "../../core/ports/outboundPorts";
import { IngestionService } from "./ingestionService";
import { NormalizationService } from "./normalizationService";

const payload: JobPayload = {
  runId: "run-int-1",
  taskId: "task-int-1",
  symbol: "AAPL",
  idempotencyKey: "aapl-int-hour",
  requestedAt: "2026-02-18T00:00:00.000Z",
};

/**
 * Validates stage handoff behavior across ingestion and normalization using in-memory adapters.
 */
describe("Pipeline integration", () => {
  it("continues with one successful source and routes normalize -> synthesize when docs are absent", async () => {
    const newsProvider: NewsProviderPort = {
      fetchArticles: async () =>
        err({
          source: "news",
          code: "provider_error",
          provider: "finnhub",
          message: "news unavailable",
          retryable: true,
        }),
    };

    const metricsProvider: MarketMetricsProviderPort = {
      fetchMetrics: async (request) =>
        ok({
          metrics: [],
          diagnostics: {
            provider: "alphavantage",
            symbol: request.symbol,
            status: "empty",
            metricCount: 0,
            reason: "No metrics in overview payload",
          },
        }),
    };

    const filingsProvider: FilingsProviderPort = {
      fetchFilings: async () =>
        err({
          source: "filings",
          code: "provider_error",
          provider: "sec-edgar",
          message: "filings unavailable",
          retryable: true,
        }),
    };

    const storedDocuments: Parameters<DocumentRepositoryPort["upsertMany"]>[0] =
      [];
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async (documents) => {
        storedDocuments.push(...documents);
      },
      listBySymbol: async () => storedDocuments,
    };

    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };

    const enqueued: Array<{ stage: string; payload: JobPayload }> = [];
    const queue: QueuePort = {
      enqueue: async (stage, nextPayload) => {
        enqueued.push({ stage, payload: nextPayload });
      },
    };

    const clock: ClockPort = {
      now: () => new Date("2026-02-18T12:00:00.000Z"),
    };

    const ids: IdGeneratorPort = {
      next: () => crypto.randomUUID(),
    };

    const ingestion = new IngestionService(
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

    await ingestion.run(payload);

    expect(enqueued.at(0)?.stage).toBe("normalize");
    expect(enqueued.at(0)?.payload.metricsDiagnostics).toEqual({
      provider: "alphavantage",
      status: "empty",
      metricCount: 0,
      reason: "No metrics in overview payload",
      httpStatus: undefined,
    });

    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok("unused"),
    };

    const normalization = new NormalizationService(documentRepo, llm, queue);
    const normalizePayload = enqueued.at(0)?.payload;
    if (!normalizePayload) {
      throw new Error("expected normalize payload from ingestion");
    }

    await normalization.run(normalizePayload);

    expect(enqueued.at(1)?.stage).toBe("synthesize");
  });
});

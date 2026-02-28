import { describe, expect, it } from "bun:test";
import { ClassifyStockService } from "./classifyStockService";
import type {
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "NVDA",
  idempotencyKey: "nvda-classify-hour",
  requestedAt: "2026-02-28T00:00:00.000Z",
};

describe("ClassifyStockService", () => {
  it("classifies high-growth high-margin profiles as compounder", async () => {
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };
    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "m1",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "alphavantage",
          metricName: "revenue_growth_yoy",
          metricValue: 0.22,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "ttm",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
        {
          id: "m2",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "alphavantage",
          metricName: "profit_margin",
          metricValue: 0.28,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "ttm",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
        {
          id: "m3",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "alphavantage",
          metricName: "price_to_earnings",
          metricValue: 42,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "ttm",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
      ],
    };
    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
    };
    const enqueues: JobPayload[] = [];
    const queue: QueuePort = {
      enqueue: async (_stage, nextPayload) => {
        enqueues.push(nextPayload);
      },
    };

    const service = new ClassifyStockService(
      documentRepo,
      metricsRepo,
      filingsRepo,
      queue,
    );
    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.thesisTypeContext?.thesisType).toBe("compounder");
  });
});


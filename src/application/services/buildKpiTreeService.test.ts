import { describe, expect, it } from "bun:test";
import { BuildKpiTreeService } from "./buildKpiTreeService";
import type {
  DocumentRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "NVDA",
  idempotencyKey: "nvda-kpi-hour",
  requestedAt: "2026-02-28T00:00:00.000Z",
  thesisTypeContext: {
    thesisType: "compounder",
    reasonCodes: ["high_growth_high_margin"],
    confidence: 80,
  },
};

describe("BuildKpiTreeService", () => {
  it("selects semis template from semiconductor evidence language", async () => {
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "d1",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "finnhub",
          providerItemId: "n1",
          type: "news",
          title: "Semiconductor demand remains strong",
          content: "GPU and chip demand remains robust.",
          url: "https://example.com",
          publishedAt: new Date("2026-02-28T00:00:00.000Z"),
          topics: [],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
      ],
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
          metricValue: 0.2,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "ttm",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
      ],
    };
    const enqueues: JobPayload[] = [];
    const queue: QueuePort = {
      enqueue: async (_stage, nextPayload) => {
        enqueues.push(nextPayload);
      },
    };

    const service = new BuildKpiTreeService(documentRepo, metricsRepo, queue);
    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.kpiContext?.template).toBe("semis");
  });

  it("improves required KPI coverage when SEC companyfacts metrics are available", async () => {
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "d2",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "finnhub",
          providerItemId: "n2",
          type: "news",
          title: "Chip demand remains strong",
          content: "Semiconductor and GPU demand remains robust.",
          url: "https://example.com/2",
          publishedAt: new Date("2026-02-28T00:00:00.000Z"),
          topics: [],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
      ],
    };
    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "m2",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "sec-companyfacts",
          metricName: "revenue_growth_yoy",
          metricValue: 0.31,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "quarter",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
        {
          id: "m3",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "sec-companyfacts",
          metricName: "profit_margin",
          metricValue: 0.28,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "quarter",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
        {
          id: "m4",
          runId: "run-1",
          taskId: "task-1",
          symbol: "NVDA",
          provider: "sec-companyfacts",
          metricName: "gross_margin",
          metricValue: 0.74,
          asOf: new Date("2026-02-28T00:00:00.000Z"),
          periodType: "quarter",
          rawPayload: {},
          createdAt: new Date("2026-02-28T00:00:00.000Z"),
        },
      ],
    };
    const enqueues: JobPayload[] = [];
    const queue: QueuePort = {
      enqueue: async (_stage, nextPayload) => {
        enqueues.push(nextPayload);
      },
    };

    const service = new BuildKpiTreeService(documentRepo, metricsRepo, queue);
    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.kpiContext?.template).toBe("semis");
    expect(enqueues[0]?.kpiContext?.requiredHitCount).toBe(3);
  });
});


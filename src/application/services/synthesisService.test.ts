import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { SynthesisService } from "./synthesisService";
import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { ResearchSnapshotEntity } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  JobPayload,
  LlmPort,
  MetricsRepositoryPort,
  SnapshotRepositoryPort,
  ClockPort,
  IdGeneratorPort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "TTWO",
  idempotencyKey: "ttwo-synthesize-hour",
  requestedAt: "2026-02-17T00:00:00.000Z",
};

describe("SynthesisService", () => {
  it("builds thesis from news, metrics, and filings evidence", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "alphavantage",
        providerItemId: "a1",
        type: "news",
        title: "Saudi fund exits TTWO",
        summary: "",
        content: "content",
        url: "https://example.com/news-1",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["ownership"],
        sourceType: "api",
        rawPayload: {},
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
      {
        id: "doc-2",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f1",
        type: "news",
        title: "TTWO guidance update",
        summary: "",
        content: "content",
        url: "https://example.com/news-2",
        publishedAt: new Date("2026-02-17T07:00:00.000Z"),
        language: "en",
        topics: ["guidance"],
        sourceType: "api",
        rawPayload: {},
        createdAt: new Date("2026-02-17T07:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "market_cap",
        metricValue: 33000000000,
        metricUnit: "usd",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-2",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.08,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];

    const filings: FilingEntity[] = [
      {
        id: "filing-1",
        dedupeKey: "accession:0000000000-26-000001",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000001",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://sec.example/filing-1",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
    ];

    let documentReadRunId: string | undefined;
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async (_symbol, _limit, runId) => {
        documentReadRunId = runId;
        return docs;
      },
    };

    let metricsReadRunId: string | undefined;
    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async (_symbol, _limit, runId) => {
        metricsReadRunId = runId;
        return metrics;
      },
    };

    let filingsReadRunId: string | undefined;
    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async (_symbol, _limit, runId) => {
        filingsReadRunId = runId;
        return filings;
      },
    };

    let capturedPrompt = "";
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        capturedPrompt = prompt;
        return ok("generated thesis");
      },
    };

    const savedSnapshots: ResearchSnapshotEntity[] = [];
    const snapshotRepo: SnapshotRepositoryPort = {
      save: async (snapshot) => {
        savedSnapshots.push(snapshot);
      },
      latestBySymbol: async () => null,
    };

    const clock: ClockPort = {
      now: () => new Date("2026-02-17T12:00:00.000Z"),
    };

    const ids: IdGeneratorPort = {
      next: () => "snapshot-1",
    };

    const service = new SynthesisService(
      documentRepo,
      metricsRepo,
      filingsRepo,
      snapshotRepo,
      llm,
      clock,
      ids,
    );

    await service.run(payload);

    expect(capturedPrompt).toContain("News headlines:");
    expect(capturedPrompt).toContain("Market metrics:");
    expect(capturedPrompt).toContain("Regulatory filings:");
    expect(capturedPrompt).toContain("Metrics fetch diagnostics:");
    expect(capturedPrompt).toContain("market_cap");
    expect(capturedPrompt).toContain("8-K filed 2026-02-15");

    const savedSnapshot = savedSnapshots.at(0);
    if (!savedSnapshot) {
      throw new Error("expected snapshot to be saved");
    }

    expect(savedSnapshot.thesis).toBe("generated thesis");
    expect(savedSnapshot.score).toBe(26);
    expect(savedSnapshot.confidence).toBe(0.81);
    expect(savedSnapshot.runId).toBe("run-1");
    expect(savedSnapshot.taskId).toBe("task-1");
    expect(documentReadRunId).toBe("run-1");
    expect(metricsReadRunId).toBe("run-1");
    expect(filingsReadRunId).toBe("run-1");

    expect(savedSnapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "alphavantage",
          url: "https://example.com/news-1",
          title: "Saudi fund exits TTWO",
        }),
        expect.objectContaining({
          provider: "alphavantage",
          title: "metric:market_cap asOf:2026-02-17T00:00:00.000Z",
        }),
        expect.objectContaining({
          provider: "sec-edgar",
          url: "https://sec.example/filing-1",
          title: "8-K 0000000000-26-000001",
        }),
      ]),
    );
  });

  it("handles missing metrics and filings evidence", async () => {
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

    let capturedPrompt = "";
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        capturedPrompt = prompt;
        return ok("fallback thesis");
      },
    };

    const savedSnapshots: ResearchSnapshotEntity[] = [];
    const snapshotRepo: SnapshotRepositoryPort = {
      save: async (snapshot) => {
        savedSnapshots.push(snapshot);
      },
      latestBySymbol: async () => null,
    };

    const clock: ClockPort = {
      now: () => new Date("2026-02-17T12:00:00.000Z"),
    };

    const ids: IdGeneratorPort = {
      next: () => "snapshot-2",
    };

    const service = new SynthesisService(
      documentRepo,
      metricsRepo,
      filingsRepo,
      snapshotRepo,
      llm,
      clock,
      ids,
    );

    await service.run(payload);

    expect(capturedPrompt).toContain("News headlines:\n- none");
    expect(capturedPrompt).toContain("Market metrics:\n- none");
    expect(capturedPrompt).toContain("Regulatory filings:\n- none");
    expect(capturedPrompt).toContain(
      "Metrics fetch diagnostics:\n- unavailable",
    );

    const savedSnapshot = savedSnapshots.at(0);
    if (!savedSnapshot) {
      throw new Error("expected snapshot to be saved");
    }

    expect(savedSnapshot.score).toBe(0);
    expect(savedSnapshot.confidence).toBe(0.1);
  });

  it("filters mock evidence when real evidence exists", async () => {
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "doc-real",
          symbol: "TTWO",
          provider: "alphavantage",
          providerItemId: "r1",
          type: "news",
          title: "Real provider headline",
          summary: "",
          content: "content",
          url: "https://example.com/real-news",
          publishedAt: new Date("2026-02-17T08:00:00.000Z"),
          language: "en",
          topics: ["ownership"],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-17T08:00:00.000Z"),
        },
        {
          id: "doc-mock",
          symbol: "TTWO",
          provider: "mock-news-wire",
          providerItemId: "m1",
          type: "news",
          title: "Mock provider headline",
          summary: "",
          content: "content",
          url: "https://example.com/mock-news",
          publishedAt: new Date("2026-02-17T07:00:00.000Z"),
          language: "en",
          topics: ["ownership"],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-17T07:00:00.000Z"),
        },
      ],
    };

    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "metric-real",
          symbol: "TTWO",
          provider: "alphavantage",
          metricName: "market_cap",
          metricValue: 33000000000,
          metricUnit: "usd",
          currency: "USD",
          asOf: new Date("2026-02-17T00:00:00.000Z"),
          periodType: "point_in_time",
          periodStart: undefined,
          periodEnd: undefined,
          confidence: 0.85,
          rawPayload: {},
          createdAt: new Date("2026-02-17T00:00:00.000Z"),
        },
        {
          id: "metric-mock",
          symbol: "TTWO",
          provider: "mock-fundamentals",
          metricName: "ev_to_ebitda",
          metricValue: 17.4,
          metricUnit: "multiple",
          currency: "USD",
          asOf: new Date("2026-02-16T00:00:00.000Z"),
          periodType: "ttm",
          periodStart: undefined,
          periodEnd: undefined,
          confidence: 0.6,
          rawPayload: {},
          createdAt: new Date("2026-02-16T00:00:00.000Z"),
        },
      ],
    };

    const filingsRepo: FilingsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "filing-real",
          dedupeKey: "accession:0000000000-26-000001",
          symbol: "TTWO",
          provider: "sec-edgar",
          issuerName: "Take-Two Interactive Software, Inc.",
          filingType: "10-Q",
          accessionNo: "0000000000-26-000001",
          filedAt: new Date("2026-02-15T00:00:00.000Z"),
          periodEnd: undefined,
          docUrl: "https://sec.example/10q",
          sections: [],
          extractedFacts: [],
          rawPayload: {},
          createdAt: new Date("2026-02-15T00:00:00.000Z"),
        },
        {
          id: "filing-mock",
          dedupeKey: "accession:000000-2026-000001",
          symbol: "TTWO",
          provider: "mock-edgar",
          issuerName: "Take-Two Interactive Software, Inc.",
          filingType: "10-Q",
          accessionNo: "000000-2026-000001",
          filedAt: new Date("2026-02-14T00:00:00.000Z"),
          periodEnd: undefined,
          docUrl: "https://example.local/filings/TTWO/10q",
          sections: [],
          extractedFacts: [],
          rawPayload: {},
          createdAt: new Date("2026-02-14T00:00:00.000Z"),
        },
      ],
    };

    let capturedPrompt = "";
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        capturedPrompt = prompt;
        return ok("filtered thesis");
      },
    };

    const savedSnapshots: ResearchSnapshotEntity[] = [];
    const snapshotRepo: SnapshotRepositoryPort = {
      save: async (snapshot) => {
        savedSnapshots.push(snapshot);
      },
      latestBySymbol: async () => null,
    };

    const clock: ClockPort = {
      now: () => new Date("2026-02-17T12:00:00.000Z"),
    };

    const ids: IdGeneratorPort = {
      next: () => "snapshot-3",
    };

    const service = new SynthesisService(
      documentRepo,
      metricsRepo,
      filingsRepo,
      snapshotRepo,
      llm,
      clock,
      ids,
    );

    await service.run(payload);

    expect(capturedPrompt).toContain("N1 alphavantage: Real provider headline");
    expect(capturedPrompt).not.toContain(
      "mock-news-wire: Mock provider headline",
    );
    expect(capturedPrompt).toContain("M1 alphavantage: market_cap");
    expect(capturedPrompt).not.toContain("mock-fundamentals: ev_to_ebitda");
    expect(capturedPrompt).toContain("F1 sec-edgar: 10-Q filed 2026-02-15");
    expect(capturedPrompt).not.toContain("mock-edgar: 10-Q filed 2026-02-14");

    const savedSnapshot = savedSnapshots.at(0);
    if (!savedSnapshot) {
      throw new Error("expected snapshot to be saved");
    }

    expect(
      savedSnapshot.sources.some(
        (source) => source.provider === "mock-news-wire",
      ),
    ).toBe(false);
    expect(
      savedSnapshot.sources.some(
        (source) => source.provider === "mock-fundamentals",
      ),
    ).toBe(false);
    expect(
      savedSnapshot.sources.some((source) => source.provider === "mock-edgar"),
    ).toBe(false);
  });
});

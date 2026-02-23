import { describe, expect, it } from "bun:test";
import { RunQueryService } from "./runQueryService";
import type {
  QueueCountsReadPort,
  QueueRunReadPort,
  RunsReadRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";

describe("RunQueryService", () => {
  it("normalizes symbol for latest snapshot lookups", async () => {
    const queueCounts: QueueCountsReadPort & QueueRunReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
      getRunState: async () => null,
      getLatestRunStateBySymbol: async () => null,
    };

    const snapshotLookups: string[] = [];
    const snapshots: SnapshotRepositoryPort = {
      save: async () => {},
      latestBySymbol: async (symbol) => {
        snapshotLookups.push(symbol);
        return null;
      },
    };

    const runsReadRepository: RunsReadRepositoryPort = {
      listRuns: async () => ({ items: [] }),
      getRunDetail: async () => null,
    };

    const service = new RunQueryService(
      queueCounts,
      snapshots,
      runsReadRepository,
    );

    const result = await service.getLatestSnapshot("  rycey  ");

    expect(result).toBeNull();
    expect(snapshotLookups).toEqual(["RYCEY"]);
  });

  it("returns queue counts from queue read port", async () => {
    const queueCounts: QueueCountsReadPort & QueueRunReadPort = {
      getQueueCountsSampled: async () => ({
        items: [
          {
            stage: "ingest",
            sampledAt: "2026-02-23T00:00:00.000Z",
            counts: {
              waiting: 1,
              active: 2,
              completed: 3,
              failed: 0,
              delayed: 0,
              paused: 0,
            },
          },
        ],
      }),
      getRunState: async () => null,
      getLatestRunStateBySymbol: async () => null,
    };

    const snapshots: SnapshotRepositoryPort = {
      save: async () => {},
      latestBySymbol: async () => null,
    };

    const runsReadRepository: RunsReadRepositoryPort = {
      listRuns: async () => ({ items: [] }),
      getRunDetail: async () => null,
    };

    const service = new RunQueryService(
      queueCounts,
      snapshots,
      runsReadRepository,
    );

    const result = await service.getQueueCounts();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.stage).toBe("ingest");
    expect(result.items[0]?.counts.active).toBe(2);
  });

  it("delegates list and detail queries to runs read repository", async () => {
    const listCalls: Array<{
      symbol?: string;
      limit?: number;
      cursor?: string;
    }> = [];
    const detailCalls: string[] = [];

    const queueCounts: QueueCountsReadPort & QueueRunReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
      getRunState: async () => null,
      getLatestRunStateBySymbol: async () => null,
    };

    const snapshots: SnapshotRepositoryPort = {
      save: async () => {},
      latestBySymbol: async () => null,
    };

    const runsReadRepository: RunsReadRepositoryPort = {
      listRuns: async (query) => {
        listCalls.push(query);
        return {
          items: [
            {
              runId: "run-1",
              taskId: "task-1",
              requestedSymbol: "RYCEY",
              canonicalSymbol: "RYCEY",
              status: "success",
              evidence: {
                documents: 1,
                metrics: 1,
                filings: 1,
              },
              createdAt: "2026-02-23T00:00:00.000Z",
              updatedAt: "2026-02-23T00:00:00.000Z",
            },
          ],
        };
      },
      getRunDetail: async (runId) => {
        detailCalls.push(runId);
        return null;
      },
    };

    const service = new RunQueryService(
      queueCounts,
      snapshots,
      runsReadRepository,
    );

    const list = await service.listRuns({ symbol: "RYCEY", limit: 5 });
    const detail = await service.getRunDetail("run-1");

    expect(list.items).toHaveLength(1);
    expect(listCalls).toEqual([{ symbol: "RYCEY", limit: 5 }]);
    expect(detail).toBeNull();
    expect(detailCalls).toEqual(["run-1"]);
  });

  it("falls back to queue-backed run state when snapshot projection is missing", async () => {
    const queueCounts: QueueCountsReadPort & QueueRunReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
      getRunState: async () => ({
        runId: "run-queued",
        taskId: "task-queued",
        symbol: "NVDA",
        requestedAt: "2026-02-23T00:00:00.000Z",
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        status: "running",
        stages: [
          { stage: "ingest", status: "running" },
          { stage: "normalize", status: "not_started" },
          { stage: "embed", status: "not_started" },
          { stage: "synthesize", status: "not_started" },
        ],
        updatedAt: "2026-02-23T00:00:05.000Z",
      }),
      getLatestRunStateBySymbol: async () => null,
    };

    const snapshots: SnapshotRepositoryPort = {
      save: async () => {},
      latestBySymbol: async () => null,
    };

    const runsReadRepository: RunsReadRepositoryPort = {
      listRuns: async () => ({ items: [] }),
      getRunDetail: async () => null,
    };

    const service = new RunQueryService(
      queueCounts,
      snapshots,
      runsReadRepository,
    );

    const detail = await service.getRunDetail("run-queued");

    expect(detail).not.toBeNull();
    expect(detail?.run.status).toBe("running");
    expect(detail?.run.runId).toBe("run-queued");
    expect(detail?.run.stages[0]?.status).toBe("running");
  });

  it("prepends queue-backed in-flight run to list when symbol filter is provided", async () => {
    const queueCounts: QueueCountsReadPort & QueueRunReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
      getRunState: async () => null,
      getLatestRunStateBySymbol: async () => ({
        runId: "run-live",
        taskId: "task-live",
        symbol: "NVDA",
        requestedAt: "2026-02-23T01:00:00.000Z",
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        status: "running",
        stages: [
          { stage: "ingest", status: "running" },
          { stage: "normalize", status: "not_started" },
          { stage: "embed", status: "not_started" },
          { stage: "synthesize", status: "not_started" },
        ],
        updatedAt: "2026-02-23T01:00:05.000Z",
      }),
    };

    const snapshots: SnapshotRepositoryPort = {
      save: async () => {},
      latestBySymbol: async () => null,
    };

    const runsReadRepository: RunsReadRepositoryPort = {
      listRuns: async () => ({
        items: [
          {
            runId: "run-persisted",
            taskId: "task-persisted",
            requestedSymbol: "NVDA",
            canonicalSymbol: "NVDA",
            status: "success",
            evidence: {
              documents: 2,
              metrics: 1,
              filings: 1,
            },
            createdAt: "2026-02-23T00:00:00.000Z",
            updatedAt: "2026-02-23T00:05:00.000Z",
          },
        ],
      }),
      getRunDetail: async () => null,
    };

    const service = new RunQueryService(
      queueCounts,
      snapshots,
      runsReadRepository,
    );

    const result = await service.listRuns({ symbol: "NVDA", limit: 10 });

    expect(result.items[0]?.runId).toBe("run-live");
    expect(result.items[0]?.status).toBe("running");
    expect(result.items[1]?.runId).toBe("run-persisted");
  });
});

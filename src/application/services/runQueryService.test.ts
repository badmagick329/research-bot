import { describe, expect, it } from "bun:test";
import { RunQueryService } from "./runQueryService";
import type {
  QueueCountsReadPort,
  RunsReadRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";

describe("RunQueryService", () => {
  it("normalizes symbol for latest snapshot lookups", async () => {
    const queueCounts: QueueCountsReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
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
    const queueCounts: QueueCountsReadPort = {
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

    const queueCounts: QueueCountsReadPort = {
      getQueueCountsSampled: async () => ({ items: [] }),
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
});

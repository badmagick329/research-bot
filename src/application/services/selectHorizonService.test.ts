import { describe, expect, it } from "bun:test";
import { SelectHorizonService } from "./selectHorizonService";
import type {
  FilingsRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "NVDA",
  idempotencyKey: "nvda-horizon-hour",
  requestedAt: "2026-02-28T00:00:00.000Z",
  thesisTypeContext: {
    thesisType: "event_driven",
    reasonCodes: ["event_window"],
    confidence: 80,
  },
};

describe("SelectHorizonService", () => {
  it("does not force 0_4_weeks without near-term event timing evidence", async () => {
    const metricsRepo: MetricsRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [],
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

    const service = new SelectHorizonService(metricsRepo, filingsRepo, queue);
    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.horizonContext?.horizon).toBe("1_2_quarters");
  });
});


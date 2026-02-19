import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import { ResearchOrchestratorService } from "./researchOrchestratorService";
import type { CompanyResolverPort } from "../../core/ports/inboundPorts";
import type {
  QueuePort,
  TaskFactoryPort,
} from "../../core/ports/outboundPorts";

describe("ResearchOrchestratorService", () => {
  it("resolves identity and enqueues canonical symbol payload", async () => {
    const enqueues: Array<{ stage: string; payload: unknown }> = [];

    const queue: QueuePort = {
      enqueue: async (stage, payload) => {
        enqueues.push({ stage, payload });
      },
    };

    const taskFactory: TaskFactoryPort = {
      create: (symbol, stage) => ({
        id: "task-1",
        runId: "run-1",
        symbol,
        requestedAt: new Date("2026-02-19T00:00:00.000Z"),
        priority: 1,
        stage,
        idempotencyKey: `${symbol}-ingest-hour`,
      }),
    };

    const resolver: CompanyResolverPort = {
      resolveCompany: async () =>
        ok({
          identity: {
            requestedSymbol: "ROLLS ROYCE",
            canonicalSymbol: "RYCEY",
            companyName: "Rolls-Royce Holdings plc",
            aliases: ["RYCEY", "RR.L"],
            exchange: "OTC",
            confidence: 0.99,
            resolutionSource: "manual_map",
          },
        }),
    };

    const service = new ResearchOrchestratorService(
      queue,
      taskFactory,
      resolver,
    );
    await service.enqueueForSymbol("rolls royce", "ingest", true);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.stage).toBe("ingest");
    expect(enqueues[0]?.payload).toEqual({
      runId: "run-1",
      taskId: "task-1",
      symbol: "RYCEY",
      idempotencyKey: "RYCEY-ingest-hour-force-task-1",
      requestedAt: "2026-02-19T00:00:00.000Z",
      resolvedIdentity: {
        requestedSymbol: "ROLLS ROYCE",
        canonicalSymbol: "RYCEY",
        companyName: "Rolls-Royce Holdings plc",
        aliases: ["RYCEY", "RR.L"],
        exchange: "OTC",
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
    });
  });

  it("throws when company resolution fails", async () => {
    const queue: QueuePort = {
      enqueue: async () => {},
    };

    const taskFactory: TaskFactoryPort = {
      create: (symbol, stage) => ({
        id: "task-1",
        runId: "run-1",
        symbol,
        requestedAt: new Date("2026-02-19T00:00:00.000Z"),
        priority: 1,
        stage,
        idempotencyKey: `${symbol}-ingest-hour`,
      }),
    };

    const resolver: CompanyResolverPort = {
      resolveCompany: async () =>
        err({
          source: "resolver",
          code: "validation_error",
          provider: "company-resolver",
          message: "Unable to resolve symbol.",
          retryable: false,
        }),
    };

    const service = new ResearchOrchestratorService(
      queue,
      taskFactory,
      resolver,
    );

    await expect(
      service.enqueueForSymbol("unknown corp", "ingest"),
    ).rejects.toThrow("Company resolution failed");
  });
});

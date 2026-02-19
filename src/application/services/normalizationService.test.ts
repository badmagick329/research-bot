import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import { NormalizationService } from "./normalizationService";
import type {
  DocumentRepositoryPort,
  JobPayload,
  LlmPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "RYCEY",
  idempotencyKey: "rycey-normalize-hour",
  requestedAt: "2026-02-19T00:00:00.000Z",
};

describe("NormalizationService", () => {
  it("degrades and forwards stage issue when normalization LLM call fails", async () => {
    const documentRepo: DocumentRepositoryPort = {
      upsertMany: async () => {},
      listBySymbol: async () => [
        {
          id: "doc-1",
          runId: "run-1",
          taskId: "task-1",
          symbol: "RYCEY",
          provider: "finnhub",
          providerItemId: "fh-1",
          type: "news",
          title: "Headline",
          summary: "Summary",
          content: "Content",
          url: "https://example.com/news",
          publishedAt: new Date("2026-02-19T00:00:00.000Z"),
          language: "en",
          topics: ["market-news"],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-19T00:00:00.000Z"),
        },
      ],
    };

    const llm: LlmPort = {
      summarize: async () =>
        err({
          source: "llm",
          code: "provider_error",
          provider: "ollama",
          message: "llm unavailable",
          retryable: true,
        }),
      synthesize: async () => ok("unused"),
    };

    const enqueues: Array<{ stage: string; payload: JobPayload }> = [];
    const queue: QueuePort = {
      enqueue: async (stage, nextPayload) => {
        enqueues.push({ stage, payload: nextPayload });
      },
    };

    const service = new NormalizationService(documentRepo, llm, queue);
    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.stage).toBe("embed");
    expect(enqueues[0]?.payload.stageIssues).toEqual([
      {
        stage: "normalize",
        status: "degraded",
        reason: "Normalization degraded due to ollama: llm unavailable",
        provider: "ollama",
        code: "provider_error",
        retryable: true,
      },
    ]);
  });
});

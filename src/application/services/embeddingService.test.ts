import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import { EmbeddingService } from "./embeddingService";
import type {
  DocumentRepositoryPort,
  EmbeddingPort,
  EmbeddingRepositoryPort,
  JobPayload,
  QueuePort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "RYCEY",
  idempotencyKey: "rycey-embed-hour",
  requestedAt: "2026-02-19T00:00:00.000Z",
};

describe("EmbeddingService", () => {
  it("degrades and forwards stage issue when embedding adapter fails", async () => {
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

    const embeddingPort: EmbeddingPort = {
      embedTexts: async () =>
        err({
          source: "embedding",
          code: "timeout",
          provider: "ollama-embedding",
          message: "embedding timed out",
          retryable: true,
        }),
    };

    const embeddingRepo: EmbeddingRepositoryPort = {
      upsertForDocument: async () => {},
    };

    const enqueues: Array<{ stage: string; payload: JobPayload }> = [];
    const queue: QueuePort = {
      enqueue: async (stage, nextPayload) => {
        enqueues.push({ stage, payload: nextPayload });
      },
    };

    const service = new EmbeddingService(
      documentRepo,
      embeddingPort,
      embeddingRepo,
      queue,
    );

    await service.run(payload);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.stage).toBe("synthesize");
    expect(enqueues[0]?.payload.stageIssues).toEqual([
      {
        stage: "embed",
        status: "degraded",
        reason:
          "Embedding degraded due to ollama-embedding: embedding timed out",
        provider: "ollama-embedding",
        code: "timeout",
        retryable: true,
      },
    ]);
  });

  it("persists available subset and marks stage issue on vector count mismatch", async () => {
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
          title: "Headline 1",
          summary: "Summary 1",
          content: "Content 1",
          url: "https://example.com/news-1",
          publishedAt: new Date("2026-02-19T00:00:00.000Z"),
          language: "en",
          topics: ["market-news"],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-19T00:00:00.000Z"),
        },
        {
          id: "doc-2",
          runId: "run-1",
          taskId: "task-1",
          symbol: "RYCEY",
          provider: "finnhub",
          providerItemId: "fh-2",
          type: "news",
          title: "Headline 2",
          summary: "Summary 2",
          content: "Content 2",
          url: "https://example.com/news-2",
          publishedAt: new Date("2026-02-19T00:00:00.000Z"),
          language: "en",
          topics: ["market-news"],
          sourceType: "api",
          rawPayload: {},
          createdAt: new Date("2026-02-19T00:00:00.000Z"),
        },
      ],
    };

    const embeddingPort: EmbeddingPort = {
      embedTexts: async () => ok([[0.1, 0.2]]),
    };

    const persistedDocIds: string[] = [];
    const embeddingRepo: EmbeddingRepositoryPort = {
      upsertForDocument: async (documentId) => {
        persistedDocIds.push(documentId);
      },
    };

    const enqueues: Array<{ stage: string; payload: JobPayload }> = [];
    const queue: QueuePort = {
      enqueue: async (stage, nextPayload) => {
        enqueues.push({ stage, payload: nextPayload });
      },
    };

    const service = new EmbeddingService(
      documentRepo,
      embeddingPort,
      embeddingRepo,
      queue,
    );

    await service.run(payload);

    expect(persistedDocIds).toEqual(["doc-1"]);
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.stage).toBe("synthesize");
    expect(enqueues[0]?.payload.stageIssues).toEqual([
      {
        stage: "embed",
        status: "degraded",
        reason:
          "Embedding returned 1 vectors for 2 documents. Persisted the available subset.",
        provider: "embedding",
        code: "dimension_mismatch",
        retryable: false,
      },
    ]);
  });
});

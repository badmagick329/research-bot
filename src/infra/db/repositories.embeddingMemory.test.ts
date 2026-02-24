import { describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { PgVectorEmbeddingRepositoryService } from "./repositories";

describe("PgVectorEmbeddingRepositoryService memory retrieval", () => {
  it("maps semantic matches and applies excludeRunId clause", async () => {
    const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
    const mockRows = [
      {
        document_id: "doc-1",
        symbol: "TTWO",
        run_id: "run-older",
        content: "historical memory content",
        similarity: 0.8123,
        created_at: "2026-01-15T00:00:00.000Z",
      },
    ];

    const sqlClient = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      sqlCalls.push({ text, values });

      if (/^\s*SELECT/i.test(text)) {
        return Promise.resolve(mockRows);
      }

      return { text, values };
    }) as unknown as postgres.Sql<{}>;

    const repo = new PgVectorEmbeddingRepositoryService(sqlClient);
    const result = await repo.findSimilarBySymbol("ttwo", [0.1, 0.2, 0.3], {
      limit: 6,
      excludeRunId: "run-current",
      from: new Date("2025-11-01T00:00:00.000Z"),
      minSimilarity: 0.72,
    });

    expect(result).toEqual([
      {
        documentId: "doc-1",
        symbol: "TTWO",
        runId: "run-older",
        content: "historical memory content",
        similarity: 0.8123,
        createdAt: new Date("2026-01-15T00:00:00.000Z"),
      },
    ]);

    expect(sqlCalls.some((call) => call.text.includes("run_id <>"))).toBeTrue();
    expect(
      sqlCalls.some((call) => call.values.includes("TTWO")),
    ).toBeTrue();
  });
});

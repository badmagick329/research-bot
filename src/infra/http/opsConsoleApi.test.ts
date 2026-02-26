import { describe, expect, it } from "bun:test";
import { createOpsConsoleApiHandler } from "./opsConsoleApi";

/**
 * Narrows response JSON to an object for strict test assertions under unknown-typed fetch payloads.
 */
const readJsonObject = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  const payload = await response.json();

  if (!payload || typeof payload !== "object") {
    return {};
  }

  return payload as Record<string, unknown>;
};

const createHandler = () => {
  const calls = {
    enqueueRun: [] as Array<{ symbol: string; force?: boolean }>,
    refreshThesis: [] as Array<{ symbol: string; runId?: string }>,
    getLatestSnapshot: [] as string[],
    listRuns: [] as Array<{ symbol?: string; limit?: number; cursor?: string }>,
    getRunDetail: [] as string[],
  };

  const handler = createOpsConsoleApiHandler({
    enqueueRun: async (request) => {
      calls.enqueueRun.push(request);
      return {
        accepted: true,
        runId: "run-1",
        taskId: "task-1",
        requestedSymbol: request.symbol,
        canonicalSymbol: request.symbol.toUpperCase(),
        idempotencyKey: "idempotency-1",
        forceApplied: Boolean(request.force),
        deduped: false,
        enqueuedAt: "2026-02-23T00:00:00.000Z",
      };
    },
    refreshThesis: async (request) => {
      calls.refreshThesis.push(request);
      return {
        accepted: true,
        runId: request.runId ?? "run-1",
        taskId: "task-1",
        requestedSymbol: request.symbol,
        canonicalSymbol: request.symbol.toUpperCase(),
        idempotencyKey: "synthesize-refresh-1",
        forceApplied: false,
        deduped: false,
        enqueuedAt: "2026-02-23T00:00:00.000Z",
      };
    },
    getQueueCounts: async () => ({
      items: [
        {
          stage: "ingest",
          sampledAt: "2026-02-23T00:00:00.000Z",
          counts: {
            waiting: 0,
            active: 1,
            completed: 2,
            failed: 0,
            delayed: 0,
            paused: 0,
          },
        },
      ],
    }),
    getLatestSnapshot: async (symbol) => {
      calls.getLatestSnapshot.push(symbol);
      if (symbol === "MISS") {
        return null;
      }

      return {
        snapshot: {
          id: "snapshot-1",
          runId: "run-1",
          taskId: "task-1",
          symbol,
          horizon: "6m",
          score: 50,
          thesis: "thesis",
          risks: [],
          catalysts: [],
          valuationView: "neutral",
          confidence: 0.5,
          sources: [],
          createdAt: new Date("2026-02-23T00:00:00.000Z"),
        },
      };
    },
    listRuns: async (query) => {
      calls.listRuns.push(query);
      return {
        items: [],
      };
    },
    getRunDetail: async (runId) => {
      calls.getRunDetail.push(runId);
      if (runId === "missing") {
        return null;
      }

      return {
        run: {
          runId,
          status: "success",
          requestedSymbol: "RYCEY",
          canonicalSymbol: "RYCEY",
          stages: [],
          evidence: {
            documents: 0,
            metrics: 0,
            filings: 0,
          },
          createdAt: "2026-02-23T00:00:00.000Z",
          updatedAt: "2026-02-23T00:00:00.000Z",
        },
      };
    },
  });

  return { handler, calls };
};

describe("createOpsConsoleApiHandler", () => {
  it("returns 202 for enqueue with normalized payload", async () => {
    const { handler, calls } = createHandler();
    const request = new Request("http://localhost/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbol: " rycey ", force: true }),
    });

    const response = await handler(request);
    const payload = await readJsonObject(response);

    expect(response.status).toBe(202);
    expect(calls.enqueueRun).toEqual([{ symbol: "rycey", force: true }]);
    expect(payload.accepted).toBe(true);
  });

  it("returns 202 for thesis refresh with optional run id", async () => {
    const { handler, calls } = createHandler();
    const request = new Request("http://localhost/api/snapshots/rycey/refresh-thesis", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId: "run-77" }),
    });

    const response = await handler(request);
    const payload = await readJsonObject(response);

    expect(response.status).toBe(202);
    expect(calls.refreshThesis).toEqual([{ symbol: "RYCEY", runId: "run-77" }]);
    expect(payload.accepted).toBe(true);
  });

  it("returns 400 for invalid enqueue body", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ symbol: "   " }),
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(400);
    const error = payload.error as { code?: string } | undefined;
    expect(error?.code).toBe("bad_request");
  });

  it("returns queue counts", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/api/queue/counts", {
        method: "GET",
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(200);
    const items = payload.items as unknown[] | undefined;
    expect(items).toHaveLength(1);
  });

  it("returns 404 for missing snapshot", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/api/snapshots/MISS/latest", {
        method: "GET",
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(404);
    const error = payload.error as { code?: string } | undefined;
    expect(error?.code).toBe("not_found");
  });

  it("passes strict query validation for list runs", async () => {
    const { handler, calls } = createHandler();
    const cursor = Buffer.from(
      JSON.stringify({
        updatedAt: "2026-02-23T00:00:00.000Z",
        runId: "run-1",
      }),
      "utf8",
    ).toString("base64url");

    const response = await handler(
      new Request(
        `http://localhost/api/runs?symbol=rycey&limit=10&cursor=${cursor}`,
        { method: "GET" },
      ),
    );

    expect(response.status).toBe(200);
    expect(calls.listRuns).toEqual([
      {
        symbol: "RYCEY",
        limit: 10,
        cursor,
      },
    ]);
  });

  it("rejects invalid cursor", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/api/runs?cursor=bad-cursor", {
        method: "GET",
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(400);
    const error = payload.error as { code?: string } | undefined;
    expect(error?.code).toBe("bad_request");
  });

  it("returns 404 for missing run detail", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/api/runs/missing", {
        method: "GET",
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(404);
    const error = payload.error as { code?: string } | undefined;
    expect(error?.code).toBe("not_found");
  });

  it("maps duplicate enqueue failures to conflict error code", async () => {
    const handler = createOpsConsoleApiHandler({
      enqueueRun: async () => {
        throw new Error("idempotency conflict: existing job");
      },
      refreshThesis: async () => {
        throw new Error("idempotency conflict: existing job");
      },
      getQueueCounts: async () => ({ items: [] }),
      getLatestSnapshot: async () => null,
      listRuns: async () => ({ items: [] }),
      getRunDetail: async () => null,
    });

    const response = await handler(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ symbol: "AAPL" }),
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(409);
    const error = payload.error as { code?: string } | undefined;
    expect(error?.code).toBe("conflict");
  });

  it("maps upstream enqueue failures to upstream_error code", async () => {
    const handler = createOpsConsoleApiHandler({
      enqueueRun: async () => {
        throw new Error("provider_error: rate_limited by upstream adapter");
      },
      refreshThesis: async () => {
        throw new Error("provider_error: rate_limited by upstream adapter");
      },
      getQueueCounts: async () => ({ items: [] }),
      getLatestSnapshot: async () => null,
      listRuns: async () => ({ items: [] }),
      getRunDetail: async () => null,
    });

    const response = await handler(
      new Request("http://localhost/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ symbol: "AAPL" }),
      }),
    );

    const payload = await readJsonObject(response);
    expect(response.status).toBe(502);
    const error = payload.error as
      | { code?: string; retryable?: boolean }
      | undefined;
    expect(error?.code).toBe("upstream_error");
    expect(error?.retryable).toBe(true);
  });
});

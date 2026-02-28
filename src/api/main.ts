import { createRuntime } from "../application/bootstrap/runtimeFactory";
import { createOpsConsoleApiHandler } from "../infra/http/opsConsoleApi";
import { env } from "../shared/config/env";
import { logger } from "../shared/logger/logger";

/**
 * Builds one synthesize-stage payload from existing snapshot run context so thesis can be refreshed without re-ingesting data.
 */
const enqueueThesisRefresh = async (
  symbol: string,
  runId: string | undefined,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
) => {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const snapshot = runId
    ? await runtime.snapshotsRepo.latestBySymbol(normalizedSymbol, runId)
    : await runtime.snapshotsRepo.latestBySymbol(normalizedSymbol);

  if (!snapshot) {
    throw new Error("Snapshot not found for requested symbol.");
  }

  if (!snapshot.runId || !snapshot.taskId) {
    throw new Error("Snapshot missing run context required for thesis refresh.");
  }

  const idempotencyKey = `${normalizedSymbol}-synthesize-refresh-${Date.now()}`;
  const enqueueReceipt = await runtime.queue.enqueueWithReceipt("synthesize", {
    runId: snapshot.runId,
    taskId: snapshot.taskId,
    symbol: normalizedSymbol,
    idempotencyKey,
    requestedAt: new Date().toISOString(),
    resolvedIdentity: snapshot.diagnostics?.identity,
    metricsDiagnostics: snapshot.diagnostics?.metrics,
    providerFailures: snapshot.diagnostics?.providerFailures,
    stageIssues: snapshot.diagnostics?.stageIssues,
    thesisTypeContext: snapshot.investorViewV2
      ? {
          thesisType: snapshot.investorViewV2.thesisType,
          reasonCodes: ["refresh_from_snapshot"],
          score: 50,
        }
      : undefined,
    horizonContext:
      snapshot.horizon === "0_4_weeks" ||
      snapshot.horizon === "1_2_quarters" ||
      snapshot.horizon === "1_3_years"
        ? {
            horizon: snapshot.horizon,
            rationale: "Restored from latest snapshot context during synthesize-only refresh.",
            score: 50,
          }
        : undefined,
    kpiContext: snapshot.investorViewV2
      ? {
          template: "generic",
          required: [],
          optional: [],
          selected: snapshot.investorViewV2.keyKpis.map((kpi) => kpi.name),
          requiredHitCount: 0,
          minRequiredForStrongNote: 0,
        }
      : undefined,
    evidenceGate: snapshot.diagnostics?.evidenceGate,
  });

  return {
    accepted: true as const,
    runId: enqueueReceipt.runId,
    taskId: enqueueReceipt.taskId,
    requestedSymbol: normalizedSymbol,
    canonicalSymbol: normalizedSymbol,
    idempotencyKey,
    forceApplied: false,
    deduped: enqueueReceipt.deduped,
    enqueuedAt: enqueueReceipt.enqueuedAt,
  };
};

/**
 * Normalizes unknown failures into structured logs so API bootstrap and shutdown errors stay diagnosable.
 */
const toErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
};

/**
 * Starts the ops-console HTTP process so external clients can trigger enqueue and polling workflows.
 */
const run = async (): Promise<void> => {
  const runtime = await createRuntime();

  const handler = createOpsConsoleApiHandler({
    enqueueRun: (request) =>
      runtime.orchestratorService.enqueueForSymbol(
        request.symbol,
        "ingest",
        Boolean(request.force),
      ),
    refreshThesis: (request) =>
      enqueueThesisRefresh(request.symbol, request.runId, runtime),
    getQueueCounts: () => runtime.runQueryService.getQueueCounts(),
    getLatestSnapshot: (symbol) =>
      runtime.runQueryService.getLatestSnapshot(symbol),
    listRuns: (query) => runtime.runQueryService.listRuns(query),
    getRunDetail: (runId) => runtime.runQueryService.getRunDetail(runId),
  });

  const server = Bun.serve({
    port: env.API_PORT,
    fetch: handler,
  });

  logger.info(
    {
      host: server.hostname,
      port: server.port,
      url: server.url.toString(),
    },
    "Ops API online",
  );

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Ops API shutting down");

    try {
      server.stop(true);
      await runtime.queue.close();
      logger.info("Ops API shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ error: toErrorDetails(error) }, "Ops API shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

run().catch((error) => {
  logger.error({ error: toErrorDetails(error) }, "Ops API bootstrap failed");
  process.exit(1);
});

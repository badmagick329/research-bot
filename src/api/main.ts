import { createRuntime } from "../application/bootstrap/runtimeFactory";
import { createOpsConsoleApiHandler } from "../infra/http/opsConsoleApi";
import { env } from "../shared/config/env";
import { logger } from "../shared/logger/logger";

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

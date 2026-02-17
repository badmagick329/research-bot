import { Command } from "commander";
import { createRuntime } from "../application/bootstrap/runtimeFactory";
import { appSymbols, env } from "../shared/config/env";
import { logger } from "../shared/logger/logger";

/**
 * Defines a single command surface so operational tasks use the same orchestration policies.
 */
export const buildCli = () => {
  const cli = new Command();
  cli.name("research-bot").description("Company research bot CLI");

  cli
    .command("run")
    .description("Start scheduler loop that enqueues ingest tasks")
    .action(async () => {
      const runtime = await createRuntime();
      const symbols = appSymbols();

      logger.info({ symbols }, "Scheduler started");

      const tick = async () => {
        await Promise.all(
          symbols.map((symbol) =>
            runtime.orchestratorService.enqueueForSymbol(symbol, "ingest"),
          ),
        );
      };

      await tick();
      setInterval(async () => {
        await tick();
      }, env.APP_RESEARCH_INTERVAL_SECONDS * 1_000);
    });

  cli
    .command("enqueue")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .action(async (opts: { symbol: string }) => {
      const runtime = await createRuntime();
      await runtime.orchestratorService.enqueueForSymbol(opts.symbol, "ingest");
      logger.info({ symbol: opts.symbol }, "Enqueued ingest task");
      process.exit(0);
    });

  cli
    .command("snapshot")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .action(async (opts: { symbol: string }) => {
      const runtime = await createRuntime();
      const snapshot = await runtime.snapshotsRepo.latestBySymbol(
        opts.symbol.toUpperCase(),
      );
      if (!snapshot) {
        logger.info({ symbol: opts.symbol }, "No snapshot found");
        process.exit(0);
      }

      logger.info({ snapshot }, "Latest snapshot");
      process.exit(0);
    });

  cli
    .command("status")
    .description("Report scheduler configuration")
    .action(() => {
      const startupWorkflow = [
        "docker compose up -d postgres redis",
        "bun run src/workers/main.ts",
        "bun run src/index.ts enqueue --symbol AAPL",
      ];

      logger.info(
        {
          symbols: appSymbols(),
          intervalSeconds: env.APP_RESEARCH_INTERVAL_SECONDS,
          newsProvider: env.NEWS_PROVIDER,
          redis: env.REDIS_URL,
          postgres: env.POSTGRES_URL,
          ollama: env.OLLAMA_BASE_URL,
          startupWorkflow,
          troubleshooting: [
            "Use AAPL (not APPL).",
            "snapshot is read-only and does not trigger a run.",
            "If no snapshot appears, keep worker terminal open and check worker logs for failed jobs.",
          ],
        },
        "Runtime status",
      );
    });

  return cli;
};

/**
 * Keeps process bootstrap thin by delegating argument parsing and command routing to one entry point.
 */
export const runCli = async (argv: string[]): Promise<void> => {
  const cli = buildCli();
  await cli.parseAsync(argv);
};

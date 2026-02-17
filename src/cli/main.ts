import { Command } from "commander";
import { createRuntime } from "../application/bootstrap/runtimeFactory";
import type { ResearchSnapshotEntity } from "../core/entities/research";
import { appSymbols, env, newsProviders } from "../shared/config/env";
import { logger } from "../shared/logger/logger";

/**
 * Formats snapshot data into a compact terminal report for easier manual inspection.
 */
const formatSnapshotReport = (snapshot: ResearchSnapshotEntity): string => {
  const lines: string[] = [];

  lines.push(`Snapshot for ${snapshot.symbol}`);
  lines.push(`Created: ${new Date(snapshot.createdAt).toISOString()}`);
  lines.push(`Horizon: ${snapshot.horizon}`);
  lines.push(`Score: ${snapshot.score.toFixed(1)} / 100`);
  lines.push(`Confidence: ${(snapshot.confidence * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("Thesis:");
  lines.push(snapshot.thesis);
  lines.push("");
  lines.push("Valuation view:");
  lines.push(snapshot.valuationView);
  lines.push("");

  lines.push("Risks:");
  if (snapshot.risks.length === 0) {
    lines.push("- none");
  } else {
    snapshot.risks.forEach((risk) => lines.push(`- ${risk}`));
  }

  lines.push("");
  lines.push("Catalysts:");
  if (snapshot.catalysts.length === 0) {
    lines.push("- none");
  } else {
    snapshot.catalysts.forEach((catalyst) => lines.push(`- ${catalyst}`));
  }

  lines.push("");
  lines.push("Sources:");
  if (snapshot.sources.length === 0) {
    lines.push("- none");
  } else {
    snapshot.sources.forEach((source, index) => {
      const title = source.title?.trim() ? source.title : "(untitled)";
      const url = source.url?.trim() ? source.url : "(no url)";
      lines.push(`${index + 1}. [${source.provider}] ${title}`);
      lines.push(`   ${url}`);
    });
  }

  return lines.join("\n");
};

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
    .option("--force", "Bypass hourly idempotency dedupe for immediate reruns")
    .action(async (opts: { symbol: string; force?: boolean }) => {
      const runtime = await createRuntime();
      await runtime.orchestratorService.enqueueForSymbol(
        opts.symbol,
        "ingest",
        Boolean(opts.force),
      );
      logger.info(
        { symbol: opts.symbol, force: Boolean(opts.force) },
        "Enqueued ingest task",
      );
      process.exit(0);
    });

  cli
    .command("snapshot")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .option("--prettify", "Render a human-friendly snapshot report")
    .action(async (opts: { symbol: string; prettify?: boolean }) => {
      const runtime = await createRuntime();
      const snapshot = await runtime.snapshotsRepo.latestBySymbol(
        opts.symbol.toUpperCase(),
      );
      if (!snapshot) {
        logger.info({ symbol: opts.symbol }, "No snapshot found");
        process.exit(0);
      }

      if (opts.prettify) {
        console.log(formatSnapshotReport(snapshot));
      } else {
        logger.info({ snapshot }, "Latest snapshot");
      }
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
          newsProviders: newsProviders(),
          redis: env.REDIS_URL,
          postgres: env.POSTGRES_URL,
          ollama: env.OLLAMA_BASE_URL,
          startupWorkflow,
          troubleshooting: [
            "Use AAPL (not APPL).",
            "snapshot is read-only and does not trigger a run.",
            "Use enqueue --force to bypass hourly idempotency for the same symbol.",
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

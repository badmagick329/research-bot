import { Command } from "commander";
import { createRuntime } from "../application/bootstrap/runtimeFactory.ts";
import { buildRefreshThesisPayload } from "../application/services/refreshThesisContextBuilder";
import type { ResearchSnapshotEntity } from "../core/entities/research";
import {
  appSymbols,
  env,
  filingsProvider,
  metricsProvider,
  newsProviders,
} from "../shared/config/env";
import { BullMqQueue } from "../infra/queue/bullMqQueue";
import { logger } from "../shared/logger/logger";

const redisConfigFromUrl = (url: string) => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
};

/**
 * Formats snapshot data into a compact terminal report with investor-facing structure first for faster manual review.
 */
export const formatSnapshotReport = (
  snapshot: ResearchSnapshotEntity,
  options?: { showRawThesis?: boolean },
): string => {
  const lines: string[] = [];
  const showRawThesis = options?.showRawThesis ?? false;
  const pushSection = (heading: string) => {
    lines.push("");
    lines.push(heading);
  };
  const formatRefs = (refs: string[]) => (refs.length > 0 ? refs.join(", ") : "none");

  lines.push(`Snapshot for ${snapshot.symbol}`);
  lines.push(`Created: ${new Date(snapshot.createdAt).toISOString()}`);
  lines.push(`Horizon: ${snapshot.horizon}`);
  lines.push(`Score: ${snapshot.score.toFixed(1)} / 100`);
  lines.push(`Confidence: ${(snapshot.confidence * 100).toFixed(1)}%`);

  if (snapshot.diagnostics?.identity) {
    const identity = snapshot.diagnostics.identity;
    pushSection("Resolved identity:");
    lines.push(`- Requested symbol: ${identity.requestedSymbol}`);
    lines.push(`- Canonical symbol: ${identity.canonicalSymbol}`);
    lines.push(`- Company: ${identity.companyName}`);
    lines.push(`- Resolution source: ${identity.resolutionSource}`);
    lines.push(`- Confidence: ${identity.confidence.toFixed(2)}`);
    if (identity.aliases.length > 0) {
      lines.push(`- Aliases: ${identity.aliases.join(", ")}`);
    }
    if (identity.exchange) {
      lines.push(`- Exchange: ${identity.exchange}`);
    }
  }

  pushSection("Data quality alerts:");
  if (snapshot.diagnostics?.kpiCoverage) {
    const kpiCoverage = snapshot.diagnostics.kpiCoverage;
    lines.push(
      `- KPI coverage: ${kpiCoverage.mode} (core ${kpiCoverage.coreCurrentCount + kpiCoverage.coreCarriedCount}/${kpiCoverage.coreRequiredCount}, sector ${kpiCoverage.sectorCurrentCount + kpiCoverage.sectorCarriedCount})`,
    );
  }
  if (snapshot.diagnostics?.sufficiencyDiagnostics) {
    const sufficiency = snapshot.diagnostics.sufficiencyDiagnostics;
    lines.push(
      `- Sufficiency: ${sufficiency.score}/${sufficiency.threshold} (${sufficiency.passed ? "pass" : "fail"})`,
    );
  }

  const providerFailures = snapshot.diagnostics?.providerFailures ?? [];
  const stageIssues = snapshot.diagnostics?.stageIssues ?? [];
  const metricsDiagnostics = snapshot.diagnostics?.metrics;
  const companyFactsDiagnostics = snapshot.diagnostics?.metricsCompanyFacts;
  if (
    providerFailures.length === 0 &&
    stageIssues.length === 0 &&
    !metricsDiagnostics &&
    !companyFactsDiagnostics &&
    !snapshot.diagnostics?.issuerMatchDiagnostics &&
    (snapshot.diagnostics?.fallbackReasonCodes ?? []).length === 0 &&
    !snapshot.diagnostics?.kpiCoverage &&
    !snapshot.diagnostics?.sufficiencyDiagnostics
  ) {
    lines.push("- none");
  } else {
    if (metricsDiagnostics) {
      lines.push(
        `- Metrics provider: ${metricsDiagnostics.provider} (${metricsDiagnostics.status}, count=${metricsDiagnostics.metricCount}${metricsDiagnostics.reason ? `, reason=${metricsDiagnostics.reason}` : ""}${typeof metricsDiagnostics.httpStatus === "number" ? `, httpStatus=${metricsDiagnostics.httpStatus}` : ""})`,
      );
    }
    if (companyFactsDiagnostics) {
      lines.push(
        `- SEC companyfacts: ${companyFactsDiagnostics.provider} (${companyFactsDiagnostics.status}, count=${companyFactsDiagnostics.metricCount}${companyFactsDiagnostics.reason ? `, reason=${companyFactsDiagnostics.reason}` : ""}${typeof companyFactsDiagnostics.httpStatus === "number" ? `, httpStatus=${companyFactsDiagnostics.httpStatus}` : ""})`,
      );
    }

    providerFailures.forEach((failure) => {
      lines.push(
        `- Provider failure: ${failure.source}/${failure.provider} (${failure.status}, itemCount=${failure.itemCount}${typeof failure.httpStatus === "number" ? `, httpStatus=${failure.httpStatus}` : ""}${typeof failure.retryable === "boolean" ? `, retryable=${failure.retryable}` : ""})`,
      );
      lines.push(`  Reason: ${failure.reason}`);
    });

    stageIssues.forEach((issue) => {
      lines.push(
        `- Stage issue: ${issue.stage}${issue.provider ? ` (${issue.provider})` : ""}${issue.code ? ` [${issue.code}]` : ""}${typeof issue.retryable === "boolean" ? ` (retryable=${issue.retryable})` : ""}`,
      );
      lines.push(`  Reason: ${issue.reason}`);
    });
    if (snapshot.diagnostics?.issuerMatchDiagnostics) {
      const issuerMatch = snapshot.diagnostics.issuerMatchDiagnostics;
      lines.push(
        `- Issuer match: title=${issuerMatch.title}, summary=${issuerMatch.summary}, content=${issuerMatch.content}, payload=${issuerMatch.payload}, payloadOnlyRejected=${issuerMatch.payloadOnlyRejected}`,
      );
    }
    if ((snapshot.diagnostics?.fallbackReasonCodes ?? []).length > 0) {
      lines.push(
        `- Fallback reasons: ${(snapshot.diagnostics?.fallbackReasonCodes ?? []).join(", ")}`,
      );
    }
  }

  const investorView = snapshot.investorViewV2;
  if (investorView) {
    pushSection("Investor view:");
    lines.push(`- Thesis type: ${investorView.thesisType}`);
    lines.push(
      `- Horizon: ${investorView.horizon.bucket}`,
    );
    lines.push(`  Why: ${investorView.horizon.rationale}`);
    lines.push(
      `- Decision: ${investorView.action.decision} (${investorView.action.positionSizing})`,
    );
    lines.push(
      `- Confidence: data=${investorView.confidence.dataConfidence}, thesis=${investorView.confidence.thesisConfidence}, timing=${investorView.confidence.timingConfidence}`,
    );
    lines.push(`- One-line thesis:`);
    lines.push(`  ${investorView.summary.oneLineThesis}`);
    if (snapshot.diagnostics?.decisionScoreBreakdown) {
      const breakdown = snapshot.diagnostics.decisionScoreBreakdown;
      lines.push("- Decision diagnostics:");
      lines.push(
        `  - Sufficiency: ${snapshot.diagnostics?.sufficiencyDiagnostics?.score ?? "n/a"}/${snapshot.diagnostics?.sufficiencyDiagnostics?.threshold ?? "n/a"} (${snapshot.diagnostics?.sufficiencyDiagnostics?.passed ? "pass" : "fail"})`,
      );
      lines.push(
        `  - Decision score: net=${breakdown.netScore.toFixed(2)} buy=${breakdown.buyScore.toFixed(2)} avoid=${breakdown.avoidScore.toFixed(2)}`,
      );
    }
    lines.push("- Variant view:");
    lines.push(`  - Priced in: ${investorView.variantView.pricedInNarrative}`);
    lines.push(`  - Our variant: ${investorView.variantView.ourVariant}`);
    lines.push(`  - Why mispriced: ${investorView.variantView.whyMispriced}`);
    lines.push("- Valuation:");
    lines.push(`  - Framework: ${investorView.valuation.valuationFramework}`);
    lines.push(`  - View: ${investorView.valuation.valuationView}`);
    lines.push(
      `  - Key multiples: ${investorView.valuation.keyMultiples.length > 0 ? investorView.valuation.keyMultiples.join(", ") : "none"}`,
    );
    lines.push("- Key KPIs:");
    if (investorView.keyKpis.length === 0) {
      lines.push("  - none");
    } else {
      investorView.keyKpis.forEach((kpi) => {
        lines.push(
          `  - ${kpi.name}: ${kpi.value} (trend: ${kpi.trend}; refs: ${formatRefs(kpi.evidenceRefs)})`,
        );
        lines.push(`    Why: ${kpi.whyItMatters}`);
      });
    }
    lines.push("- Catalysts:");
    if (investorView.catalysts.length === 0) {
      lines.push("  - none");
    } else {
      investorView.catalysts.forEach((catalyst) => {
        lines.push(`  - ${catalyst.event}`);
        lines.push(`    Window: ${catalyst.window}`);
        lines.push(`    Expected direction: ${catalyst.expectedDirection}`);
        lines.push(`    Why: ${catalyst.whyItMatters}`);
        lines.push(`    Refs: ${formatRefs(catalyst.evidenceRefs)}`);
      });
    }
    lines.push("- Falsification:");
    if (investorView.falsification.length === 0) {
      lines.push("  - none");
    } else {
      investorView.falsification.forEach((item) => {
        lines.push(`  - ${item.condition}`);
        lines.push(`    Type: ${item.type}`);
        lines.push(`    Threshold/outcome: ${item.thresholdOrOutcome}`);
        lines.push(`    Deadline: ${item.deadline}`);
        lines.push(`    Action if hit: ${item.actionIfHit}`);
        lines.push(`    Refs: ${formatRefs(item.evidenceRefs)}`);
      });
    }
  }

  if (showRawThesis) {
    pushSection("Thesis (raw markdown):");
    lines.push(snapshot.thesis);
  }

  pushSection("Valuation view:");
  lines.push(snapshot.valuationView);

  pushSection("Risks:");
  if (snapshot.risks.length === 0) {
    lines.push("- none");
  } else {
    snapshot.risks.forEach((risk) => lines.push(`- ${risk}`));
  }

  if (!snapshot.investorViewV2) {
    pushSection("Catalysts:");
    if (snapshot.catalysts.length === 0) {
      lines.push("- none");
    } else {
      snapshot.catalysts.forEach((catalyst) => lines.push(`- ${catalyst}`));
    }
  }

  pushSection("Sources:");
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
      const enqueueResult = await runtime.orchestratorService.enqueueForSymbol(
        opts.symbol,
        "ingest",
        Boolean(opts.force),
      );
      logger.info({ enqueue: enqueueResult }, "Enqueued ingest task");
      process.exit(0);
    });

  cli
    .command("refresh-thesis")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .option(
      "--run-id <runId>",
      "Optional run id; defaults to the latest snapshot run for the symbol",
    )
    .action(async (opts: { symbol: string; runId?: string }) => {
      const runtime = await createRuntime();
      const normalizedSymbol = opts.symbol.trim().toUpperCase();
      const snapshot = opts.runId
        ? await runtime.snapshotsRepo.latestBySymbol(normalizedSymbol, opts.runId)
        : await runtime.snapshotsRepo.latestBySymbol(normalizedSymbol);

      if (!snapshot) {
        logger.info(
          { symbol: normalizedSymbol, runId: opts.runId },
          "No snapshot found to refresh thesis",
        );
        process.exit(0);
      }

      if (!snapshot.runId || !snapshot.taskId) {
        logger.error(
          { symbol: normalizedSymbol, runId: snapshot.runId, taskId: snapshot.taskId },
          "Snapshot missing run context required for thesis refresh",
        );
        process.exit(1);
      }

      const idempotencyKey = `${normalizedSymbol}-synthesize-refresh-${Date.now()}`;
      const enqueueReceipt = await runtime.queue.enqueueWithReceipt(
        "synthesize",
        buildRefreshThesisPayload(snapshot, normalizedSymbol, idempotencyKey),
      );

      logger.info(
        {
          refreshThesis: {
            symbol: normalizedSymbol,
            runId: enqueueReceipt.runId,
            taskId: enqueueReceipt.taskId,
            idempotencyKey,
            enqueuedAt: enqueueReceipt.enqueuedAt,
            deduped: enqueueReceipt.deduped,
          },
        },
        "Enqueued thesis refresh (synthesize-only)",
      );
      process.exit(0);
    });

  cli
    .command("snapshot")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .option("--prettify", "Render a human-friendly snapshot report")
    .option(
      "--show-raw-thesis",
      "Include raw markdown thesis when used with --prettify",
    )
    .action(
      async (opts: {
        symbol: string;
        prettify?: boolean;
        showRawThesis?: boolean;
      }) => {
        const runtime = await createRuntime();
        const snapshot = await runtime.snapshotsRepo.latestBySymbol(
          opts.symbol.toUpperCase(),
        );
        if (!snapshot) {
          logger.info({ symbol: opts.symbol }, "No snapshot found");
          process.exit(0);
        }

        if (opts.prettify) {
          console.log(
            formatSnapshotReport(snapshot, {
              showRawThesis: Boolean(opts.showRawThesis),
            }),
          );
        } else {
          logger.info({ snapshot }, "Latest snapshot");
        }
        process.exit(0);
      },
    );

  cli
    .command("status")
    .description("Report scheduler configuration")
    .action(async () => {
      const startupWorkflow = [
        "docker compose up -d postgres redis",
        "bun run src/workers/main.ts",
        "bun run src/index.ts enqueue --symbol AAPL",
      ];

      const queue = new BullMqQueue(redisConfigFromUrl(env.REDIS_URL));
      const queueCounts = await queue.getQueueCounts();
      await queue.close();

      logger.info(
        {
          symbols: appSymbols(),
          intervalSeconds: env.APP_RESEARCH_INTERVAL_SECONDS,
          newsProvider: env.NEWS_PROVIDER,
          newsProviders: newsProviders(),
          metricsProvider: metricsProvider(),
          filingsProvider: filingsProvider(),
          redis: env.REDIS_URL,
          postgres: env.POSTGRES_URL,
          ollama: env.OLLAMA_BASE_URL,
          queueCounts,
          startupWorkflow,
          troubleshooting: [
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

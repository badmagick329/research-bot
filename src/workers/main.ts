import { createRuntime } from "../application/bootstrap/runtimeFactory";
import { createStageWorker } from "../infra/queue/bullMqQueue";
import {
  env,
  filingsProvider,
  metricsProvider,
  newsProviders,
} from "../shared/config/env";
import { logger } from "../shared/logger/logger";

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

const redisConfigFromUrl = (url: string) => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
};

const run = async (): Promise<void> => {
  const runtime = await createRuntime();
  const redis = redisConfigFromUrl(env.REDIS_URL);
  const startedAtByJobId = new Map<string, number>();

  logger.info(
    {
      newsProvider: env.NEWS_PROVIDER,
      newsProviders: newsProviders(),
      finnhubBaseUrl: env.FINNHUB_BASE_URL,
      finnhubApiKeyConfigured: env.FINNHUB_API_KEY.trim().length > 0,
      alphaVantageBaseUrl: env.ALPHA_VANTAGE_BASE_URL,
      alphaVantageApiKeyConfigured: env.ALPHA_VANTAGE_API_KEY.trim().length > 0,
      metricsProvider: metricsProvider(),
      filingsProvider: filingsProvider(),
      secEdgarBaseUrl: env.SEC_EDGAR_BASE_URL,
      secEdgarApiUserAgentConfigured:
        env.SEC_EDGAR_USER_AGENT.trim().length > 0,
      redisUrl: env.REDIS_URL,
      postgresUrl: env.POSTGRES_URL,
    },
    "Worker runtime configuration",
  );

  const ingestWorker = createStageWorker(
    "ingest",
    redis,
    env.QUEUE_CONCURRENCY_INGEST,
    (payload) => runtime.ingestionService.run(payload),
  );
  const normalizeWorker = createStageWorker(
    "normalize",
    redis,
    env.QUEUE_CONCURRENCY_NORMALIZE,
    (payload) => runtime.normalizationService.run(payload),
  );
  const embedWorker = createStageWorker(
    "embed",
    redis,
    env.QUEUE_CONCURRENCY_EMBED,
    (payload) => runtime.embeddingService.run(payload),
  );
  const synthesizeWorker = createStageWorker(
    "synthesize",
    redis,
    env.QUEUE_CONCURRENCY_SYNTHESIZE,
    (payload) => runtime.synthesisService.run(payload),
  );

  [ingestWorker, normalizeWorker, embedWorker, synthesizeWorker].forEach(
    (worker) => {
      worker.on("active", (job) => {
        if (!job?.id) {
          return;
        }

        startedAtByJobId.set(job.id, Date.now());

        logger.info(
          {
            stage: worker.name,
            jobId: job.id,
            runId: job.data.runId,
            taskId: job.data.taskId,
            symbol: job.data.symbol,
            idempotencyKey: job.data.idempotencyKey,
          },
          "Worker job started",
        );
      });

      worker.on("failed", (job, error) => {
        const startedAt = job?.id ? startedAtByJobId.get(job.id) : undefined;
        const durationMs = startedAt ? Date.now() - startedAt : undefined;

        if (job?.id) {
          startedAtByJobId.delete(job.id);
        }

        logger.error(
          {
            stage: worker.name,
            jobId: job?.id,
            runId: job?.data.runId,
            taskId: job?.data.taskId,
            symbol: job?.data.symbol,
            idempotencyKey: job?.data.idempotencyKey,
            durationMs,
            error: toErrorDetails(error),
          },
          "Worker job failed",
        );
      });
      worker.on("completed", (job) => {
        const startedAt = job.id ? startedAtByJobId.get(job.id) : undefined;
        const durationMs = startedAt ? Date.now() - startedAt : undefined;

        if (job.id) {
          startedAtByJobId.delete(job.id);
        }

        logger.info(
          {
            stage: worker.name,
            jobId: job.id,
            runId: job.data.runId,
            taskId: job.data.taskId,
            symbol: job.data.symbol,
            idempotencyKey: job.data.idempotencyKey,
            durationMs,
            providerFailureCount: job.data.providerFailures?.length ?? 0,
            stageIssueCount: job.data.stageIssues?.length ?? 0,
            metricsStatus: job.data.metricsDiagnostics?.status,
          },
          "Worker job completed",
        );
      });
    },
  );

  logger.info("Workers online");
};

run().catch((error) => {
  logger.error({ error: toErrorDetails(error) }, "Worker bootstrap failed");
  process.exit(1);
});

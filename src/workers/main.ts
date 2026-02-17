import { createRuntime } from "../application/bootstrap/runtimeFactory";
import { createStageWorker } from "../infra/queue/bullMqQueue";
import { env } from "../shared/config/env";
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
      worker.on("failed", (job, error) => {
        logger.error(
          { stage: worker.name, jobId: job?.id, error },
          "Worker job failed",
        );
      });
      worker.on("completed", (job) => {
        logger.info(
          { stage: worker.name, jobId: job.id },
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

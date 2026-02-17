import { ResearchOrchestratorService } from "../services/researchOrchestratorService";
import { IngestionService } from "../services/ingestionService";
import { NormalizationService } from "../services/normalizationService";
import { EmbeddingService } from "../services/embeddingService";
import { SynthesisService } from "../services/synthesisService";
import { env } from "../../shared/config/env";
import { createDb } from "../../infra/db/client";
import {
  PgVectorEmbeddingRepositoryService,
  PostgresDocumentRepositoryService,
  PostgresFilingsRepositoryService,
  PostgresMetricsRepositoryService,
  PostgresSnapshotRepositoryService,
} from "../../infra/db/repositories";
import { OllamaEmbedding } from "../../infra/llm/ollamaEmbedding";
import { OllamaLlm } from "../../infra/llm/ollamaLlm";
import { FinnhubNewsProvider } from "../../infra/providers/finnhub/finnhubNewsProvider";
import { MockFilingsProvider } from "../../infra/providers/mocks/mockFilingsProvider";
import { MockMarketMetricsProvider } from "../../infra/providers/mocks/mockMarketMetricsProvider";
import { MockNewsProvider } from "../../infra/providers/mocks/mockNewsProvider";
import { BullMqQueue } from "../../infra/queue/bullMqQueue";
import {
  SystemClock,
  TaskFactory,
  UuidIdGenerator,
} from "../../infra/system/systemPorts";

const redisConfigFromUrl = (url: string) => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
};

export const VECTOR_DIMENSION = 1024;

/**
 * Centralizes runtime wiring so app and worker entry points share one composition root.
 */
export const createRuntime = async () => {
  const { db, sql } = createDb(env.POSTGRES_URL);

  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const taskFactory = new TaskFactory(clock, ids);

  const queue = new BullMqQueue(redisConfigFromUrl(env.REDIS_URL));

  const documentRepo = new PostgresDocumentRepositoryService(db);
  const metricsRepo = new PostgresMetricsRepositoryService(db);
  const filingsRepo = new PostgresFilingsRepositoryService(db);
  const embeddingsRepo = new PgVectorEmbeddingRepositoryService(sql);
  const snapshotsRepo = new PostgresSnapshotRepositoryService(db);

  const llm = new OllamaLlm(
    env.OLLAMA_BASE_URL,
    env.OLLAMA_CHAT_MODEL,
    env.OLLAMA_CHAT_TIMEOUT_MS,
  );
  const embedder = new OllamaEmbedding(
    env.OLLAMA_BASE_URL,
    env.OLLAMA_EMBED_MODEL,
    VECTOR_DIMENSION,
    env.OLLAMA_EMBED_TIMEOUT_MS,
  );

  const newsProvider =
    env.NEWS_PROVIDER === "finnhub"
      ? new FinnhubNewsProvider(
          env.FINNHUB_BASE_URL,
          env.FINNHUB_API_KEY,
          env.FINNHUB_TIMEOUT_MS,
        )
      : new MockNewsProvider();
  const metricsProvider = new MockMarketMetricsProvider();
  const filingsProvider = new MockFilingsProvider();

  const orchestratorService = new ResearchOrchestratorService(
    queue,
    taskFactory,
  );
  const ingestionService = new IngestionService(
    newsProvider,
    metricsProvider,
    filingsProvider,
    documentRepo,
    metricsRepo,
    filingsRepo,
    queue,
    clock,
    ids,
    env.APP_LOOKBACK_DAYS,
  );
  const normalizationService = new NormalizationService(
    documentRepo,
    llm,
    queue,
  );
  const embeddingService = new EmbeddingService(
    documentRepo,
    embedder,
    embeddingsRepo,
    queue,
  );
  const synthesisService = new SynthesisService(
    documentRepo,
    snapshotsRepo,
    llm,
    clock,
    ids,
  );

  return {
    queue,
    snapshotsRepo,
    orchestratorService,
    ingestionService,
    normalizationService,
    embeddingService,
    synthesisService,
  };
};

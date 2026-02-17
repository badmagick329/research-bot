import { ResearchOrchestratorService } from "../services/researchOrchestratorService";
import { IngestionService } from "../services/ingestionService";
import { NormalizationService } from "../services/normalizationService";
import { EmbeddingService } from "../services/embeddingService";
import { SynthesisService } from "../services/synthesisService";
import {
  env,
  filingsProvider,
  metricsProvider,
  newsProviders,
} from "../../shared/config/env";
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
import { AlphaVantageMetricsProvider } from "../../infra/providers/alphavantage/alphaVantageMetricsProvider";
import { AlphaVantageNewsProvider } from "../../infra/providers/alphavantage/alphaVantageNewsProvider";
import { FinnhubNewsProvider } from "../../infra/providers/finnhub/finnhubNewsProvider";
import { MockFilingsProvider } from "../../infra/providers/mocks/mockFilingsProvider";
import { MockMarketMetricsProvider } from "../../infra/providers/mocks/mockMarketMetricsProvider";
import { MockNewsProvider } from "../../infra/providers/mocks/mockNewsProvider";
import { MultiNewsProvider } from "../../infra/providers/multiNewsProvider";
import { SecEdgarFilingsProvider } from "../../infra/providers/sec/secEdgarFilingsProvider";
import { BullMqQueue } from "../../infra/queue/bullMqQueue";
import {
  SystemClock,
  TaskFactory,
  UuidIdGenerator,
} from "../../infra/system/systemPorts";
import type {
  FilingsProviderPort,
  MarketMetricsProviderPort,
  NewsProviderPort,
} from "../../core/ports/inboundPorts";

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

const createNewsProvider = (): NewsProviderPort => {
  const providers = newsProviders().map((providerName) => {
    if (providerName === "finnhub") {
      return new FinnhubNewsProvider(
        env.FINNHUB_BASE_URL,
        env.FINNHUB_API_KEY,
        env.FINNHUB_TIMEOUT_MS,
      );
    }

    if (providerName === "alphavantage") {
      return new AlphaVantageNewsProvider(
        env.ALPHA_VANTAGE_BASE_URL,
        env.ALPHA_VANTAGE_API_KEY,
        env.ALPHA_VANTAGE_TIMEOUT_MS,
      );
    }

    return new MockNewsProvider();
  });

  if (providers.length === 1) {
    const provider = providers.at(0);
    if (!provider) {
      throw new Error("No news provider resolved from configuration.");
    }
    return provider;
  }

  return new MultiNewsProvider(providers);
};

/**
 * Resolves the configured metrics adapter while preserving a mock fallback for local development.
 */
const createMetricsProvider = (): MarketMetricsProviderPort => {
  if (metricsProvider() === "alphavantage") {
    return new AlphaVantageMetricsProvider(
      env.ALPHA_VANTAGE_BASE_URL,
      env.ALPHA_VANTAGE_API_KEY,
      env.ALPHA_VANTAGE_TIMEOUT_MS,
    );
  }

  return new MockMarketMetricsProvider();
};

/**
 * Resolves the configured filings adapter while preserving a mock fallback for local development.
 */
const createFilingsProvider = (): FilingsProviderPort => {
  if (filingsProvider() === "sec-edgar") {
    return new SecEdgarFilingsProvider(
      env.SEC_EDGAR_BASE_URL,
      env.SEC_EDGAR_ARCHIVES_BASE_URL,
      env.SEC_EDGAR_TICKERS_URL,
      env.SEC_EDGAR_USER_AGENT,
      env.SEC_EDGAR_TIMEOUT_MS,
    );
  }

  return new MockFilingsProvider();
};

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

  const newsProvider = createNewsProvider();
  const metricsProviderAdapter = createMetricsProvider();
  const filingsProviderAdapter = createFilingsProvider();

  const orchestratorService = new ResearchOrchestratorService(
    queue,
    taskFactory,
  );
  const ingestionService = new IngestionService(
    newsProvider,
    metricsProviderAdapter,
    filingsProviderAdapter,
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
    metricsRepo,
    filingsRepo,
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

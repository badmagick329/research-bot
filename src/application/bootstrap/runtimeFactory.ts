import { ResearchOrchestratorService } from "../services/researchOrchestratorService";
import { IngestionService } from "../services/ingestionService";
import { NormalizationService } from "../services/normalizationService";
import { EmbeddingService } from "../services/embeddingService";
import { SynthesisService } from "../services/synthesisService";
import { RunQueryService } from "../services/runQueryService";
import {
  env,
  filingsProvider,
  llmProvider,
  metricsProvider,
  newsRelevanceMode,
  newsProviders,
} from "../../shared/config/env";
import { createDb } from "../../infra/db/client";
import {
  PgVectorEmbeddingRepositoryService,
  PostgresDocumentRepositoryService,
  PostgresFilingsRepositoryService,
  PostgresMetricsRepositoryService,
  PostgresRunsReadRepositoryService,
  PostgresSnapshotRepositoryService,
} from "../../infra/db/repositories";
import { OllamaEmbedding } from "../../infra/llm/ollamaEmbedding";
import { OllamaLlm } from "../../infra/llm/ollamaLlm";
import { OpenAiLlm } from "../../infra/llm/openAiLlm";
import { AlphaVantageMetricsProvider } from "../../infra/providers/alphavantage/alphaVantageMetricsProvider";
import { AlphaVantageNewsProvider } from "../../infra/providers/alphavantage/alphaVantageNewsProvider";
import { FinnhubNewsProvider } from "../../infra/providers/finnhub/finnhubNewsProvider";
import { FinnhubMarketContextProvider } from "../../infra/providers/finnhub/finnhubMarketContextProvider";
import { MockFilingsProvider } from "../../infra/providers/mocks/mockFilingsProvider";
import { MockMarketMetricsProvider } from "../../infra/providers/mocks/mockMarketMetricsProvider";
import { MockNewsProvider } from "../../infra/providers/mocks/mockNewsProvider";
import { MultiNewsProvider } from "../../infra/providers/multiNewsProvider";
import { CompanyResolver } from "../../infra/providers/company/companyResolver";
import { SecEdgarFilingsProvider } from "../../infra/providers/sec/secEdgarFilingsProvider";
import { BullMqQueue } from "../../infra/queue/bullMqQueue";
import { HttpJsonClient } from "../../infra/http/httpJsonClient";
import {
  SystemClock,
  TaskFactory,
  UuidIdGenerator,
} from "../../infra/system/systemPorts";
import { RedisProviderRateLimiter } from "../../infra/system/redisProviderRateLimiter";
import type {
  FilingsProviderPort,
  MarketContextProviderPort,
  MarketMetricsProviderPort,
  NewsProviderPort,
} from "../../core/ports/inboundPorts";
import type {
  LlmPort,
  ProviderRateLimiterPort,
} from "../../core/ports/outboundPorts";
import { ok } from "neverthrow";

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

const createNewsProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): NewsProviderPort => {
  const providers = newsProviders().map((providerName) => {
    if (providerName === "finnhub") {
      return new FinnhubNewsProvider(
        env.FINNHUB_BASE_URL,
        env.FINNHUB_API_KEY,
        env.FINNHUB_TIMEOUT_MS,
        httpClient,
        providerRateLimiter,
      );
    }

    if (providerName === "alphavantage") {
      return new AlphaVantageNewsProvider(
        env.ALPHA_VANTAGE_BASE_URL,
        env.ALPHA_VANTAGE_API_KEY,
        env.ALPHA_VANTAGE_TIMEOUT_MS,
        httpClient,
        providerRateLimiter,
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
const createMetricsProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): MarketMetricsProviderPort => {
  if (metricsProvider() === "alphavantage") {
    return new AlphaVantageMetricsProvider(
      env.ALPHA_VANTAGE_BASE_URL,
      env.ALPHA_VANTAGE_API_KEY,
      env.ALPHA_VANTAGE_TIMEOUT_MS,
      httpClient,
      providerRateLimiter,
    );
  }

  return new MockMarketMetricsProvider();
};

/**
 * Resolves the configured filings adapter while preserving a mock fallback for local development.
 */
const createFilingsProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): FilingsProviderPort => {
  if (filingsProvider() === "sec-edgar") {
    return new SecEdgarFilingsProvider(
      env.SEC_EDGAR_BASE_URL,
      env.SEC_EDGAR_ARCHIVES_BASE_URL,
      env.SEC_EDGAR_TICKERS_URL,
      env.SEC_EDGAR_USER_AGENT,
      env.SEC_EDGAR_TIMEOUT_MS,
      httpClient,
      providerRateLimiter,
    );
  }

  return new MockFilingsProvider();
};

/**
 * Resolves market-context enrichment adapter and falls back to empty enrichment when Finnhub credentials are unavailable.
 */
const createMarketContextProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): MarketContextProviderPort => {
  if (!env.FINNHUB_API_KEY.trim()) {
    return {
      fetchMarketContext: async (request) =>
        ok({
          peerRelativeValuation: [],
          earningsGuidance: [],
          analystTrend: [],
          diagnostics: {
            provider: "market-context-disabled",
            symbol: request.symbol,
            status: "empty",
            itemCounts: {
              peerRelativeValuation: 0,
              earningsGuidance: 0,
              analystTrend: 0,
            },
          },
        }),
    };
  }

  return new FinnhubMarketContextProvider(
    env.FINNHUB_BASE_URL,
    env.FINNHUB_API_KEY,
    env.FINNHUB_TIMEOUT_MS,
    httpClient,
    providerRateLimiter,
  );
};

/**
 * Resolves the configured LLM adapter so runtime can switch between local and external chat models.
 */
const createLlm = (httpClient: HttpJsonClient): LlmPort => {
  if (llmProvider() === "openai") {
    return new OpenAiLlm(
      env.OPENAI_BASE_URL,
      env.OPENAI_API_KEY,
      env.OPENAI_CHAT_MODEL,
      env.OPENAI_CHAT_TIMEOUT_MS,
      httpClient,
    );
  }

  return new OllamaLlm(
    env.OLLAMA_BASE_URL,
    env.OLLAMA_CHAT_MODEL,
    env.OLLAMA_CHAT_TIMEOUT_MS,
    httpClient,
  );
};

/**
 * Centralizes runtime wiring so app and worker entry points share one composition root.
 */
export const createRuntime = async () => {
  const { db, sql } = createDb(env.POSTGRES_URL);

  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const taskFactory = new TaskFactory(clock, ids);
  const companyResolver = new CompanyResolver();

  const redisConnection = redisConfigFromUrl(env.REDIS_URL);
  const queue = new BullMqQueue(redisConnection);
  const httpClient = new HttpJsonClient();
  const providerRateLimiter = new RedisProviderRateLimiter(redisConnection, {
    alphavantage: env.ALPHA_VANTAGE_MIN_INTERVAL_MS,
    finnhub: env.FINNHUB_MIN_INTERVAL_MS,
    "sec-edgar": env.SEC_EDGAR_MIN_INTERVAL_MS,
  });

  const documentRepo = new PostgresDocumentRepositoryService(db);
  const metricsRepo = new PostgresMetricsRepositoryService(db);
  const filingsRepo = new PostgresFilingsRepositoryService(db);
  const embeddingsRepo = new PgVectorEmbeddingRepositoryService(sql);
  const snapshotsRepo = new PostgresSnapshotRepositoryService(db);
  const runsReadRepository = new PostgresRunsReadRepositoryService(db);

  const llm = createLlm(httpClient);
  const embedder = new OllamaEmbedding(
    env.OLLAMA_BASE_URL,
    env.OLLAMA_EMBED_MODEL,
    VECTOR_DIMENSION,
    env.OLLAMA_EMBED_TIMEOUT_MS,
    httpClient,
  );

  const newsProvider = createNewsProvider(httpClient, providerRateLimiter);
  const metricsProviderAdapter = createMetricsProvider(
    httpClient,
    providerRateLimiter,
  );
  const filingsProviderAdapter = createFilingsProvider(
    httpClient,
    providerRateLimiter,
  );
  const marketContextProvider = createMarketContextProvider(
    httpClient,
    providerRateLimiter,
  );

  const orchestratorService = new ResearchOrchestratorService(
    queue,
    taskFactory,
    companyResolver,
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
    env.APP_NEWS_LOOKBACK_DAYS,
    env.APP_FILINGS_LOOKBACK_DAYS,
    marketContextProvider,
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
    embedder,
    embeddingsRepo,
    snapshotsRepo,
    llm,
    clock,
    ids,
    {
      relevanceMode: newsRelevanceMode(),
      minRelevanceScore: env.NEWS_MIN_RELEVANCE_SCORE,
      issuerMatchMinFields: env.NEWS_ISSUER_MATCH_MIN_FIELDS,
      thesisTriggerMinNumeric: env.THESIS_TRIGGER_MIN_NUMERIC,
    },
  );
  const runQueryService = new RunQueryService(
    queue,
    snapshotsRepo,
    runsReadRepository,
  );

  return {
    queue,
    snapshotsRepo,
    runQueryService,
    orchestratorService,
    ingestionService,
    normalizationService,
    embeddingService,
    synthesisService,
  };
};

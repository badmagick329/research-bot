import { ResearchOrchestratorService } from "../services/researchOrchestratorService";
import { IngestionService } from "../services/ingestionService";
import { NormalizationService } from "../services/normalizationService";
import { EmbeddingService } from "../services/embeddingService";
import { SynthesisService } from "../services/synthesisService";
import { ClassifyStockService } from "../services/classifyStockService";
import { SelectHorizonService } from "../services/selectHorizonService";
import { BuildKpiTreeService } from "../services/buildKpiTreeService";
import { RunQueryService } from "../services/runQueryService";
import {
  env,
  filingsProvider,
  llmProvider,
  metricsProvider,
  newsRelevanceMode,
  newsV2SourceQualityMode,
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
import { FredMacroProvider } from "../../infra/providers/fred/fredMacroProvider";
import { BlsMacroProvider } from "../../infra/providers/bls/blsMacroProvider";
import { MockFilingsProvider } from "../../infra/providers/mocks/mockFilingsProvider";
import { MockMarketMetricsProvider } from "../../infra/providers/mocks/mockMarketMetricsProvider";
import { MockNewsProvider } from "../../infra/providers/mocks/mockNewsProvider";
import { MultiMacroProvider } from "../../infra/providers/macro/multiMacroProvider";
import { MultiNewsProvider } from "../../infra/providers/multiNewsProvider";
import { CompanyResolver } from "../../infra/providers/company/companyResolver";
import { SecEdgarFilingsProvider } from "../../infra/providers/sec/secEdgarFilingsProvider";
import { SecCompanyFactsProvider } from "../../infra/providers/sec/secCompanyFactsProvider";
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
  CompanyFactsProviderPort,
  MacroContextProviderPort,
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
          priceContext: [],
          diagnostics: {
            provider: "market-context-disabled",
            symbol: request.symbol,
            status: "empty",
            itemCounts: {
              peerRelativeValuation: 0,
              earningsGuidance: 0,
              analystTrend: 0,
              priceContext: 0,
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
 * Resolves SEC companyfacts adapter with an explicit disabled fallback so metrics merge remains deterministic in all environments.
 */
const createCompanyFactsProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): CompanyFactsProviderPort => {
  if (!env.SEC_COMPANYFACTS_ENABLED) {
    return {
      fetchCompanyFacts: async (request) =>
        ok({
          metrics: [],
          diagnostics: {
            provider: "sec-companyfacts-disabled",
            symbol: request.symbol,
            status: "empty",
            metricCount: 0,
            reason: "SEC companyfacts disabled by configuration.",
          },
        }),
    };
  }

  return new SecCompanyFactsProvider(
    env.SEC_EDGAR_BASE_URL,
    env.SEC_EDGAR_TICKERS_URL,
    env.SEC_EDGAR_USER_AGENT,
    env.SEC_COMPANYFACTS_TIMEOUT_MS,
    env.SEC_COMPANYFACTS_MAX_FACTS_PER_METRIC,
    httpClient,
    providerRateLimiter,
  );
};

/**
 * Resolves sector-agnostic macro enrichment adapter and degrades to empty diagnostics when disabled by config.
 */
const createMacroContextProvider = (
  httpClient: HttpJsonClient,
  providerRateLimiter: ProviderRateLimiterPort,
): MacroContextProviderPort => {
  if (!env.MACRO_OVERLAY_ENABLED) {
    return {
      fetchMacroContext: async () =>
        ok({
          metrics: [],
          diagnostics: [],
        }),
    };
  }

  const providers: MacroContextProviderPort[] = [];
  if (env.MACRO_FRED_ENABLED) {
    if (env.FRED_API_KEY.trim()) {
      providers.push(
        new FredMacroProvider(
          env.FRED_BASE_URL,
          env.FRED_API_KEY,
          env.FRED_TIMEOUT_MS,
          env.MACRO_LOOKBACK_MONTHS,
          httpClient,
          providerRateLimiter,
        ),
      );
    } else {
      providers.push({
        fetchMacroContext: async () =>
          ok({
            metrics: [],
            diagnostics: [
              {
                provider: "fred",
                status: "config_invalid",
                metricCount: 0,
                reason: "FRED_API_KEY is missing.",
              },
            ],
          }),
      });
    }
  }
  if (env.MACRO_BLS_ENABLED) {
    providers.push(
      new BlsMacroProvider(
        env.BLS_BASE_URL,
        env.BLS_API_KEY,
        env.BLS_TIMEOUT_MS,
        env.MACRO_LOOKBACK_MONTHS,
        httpClient,
        providerRateLimiter,
      ),
    );
  }

  if (providers.length === 0) {
    return {
      fetchMacroContext: async () =>
        ok({
          metrics: [],
          diagnostics: [],
        }),
    };
  }

  return new MultiMacroProvider(providers);
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
    fred: env.FRED_MIN_INTERVAL_MS,
    bls: env.BLS_MIN_INTERVAL_MS,
  }, {
    alphavantage: env.ALPHA_VANTAGE_DAILY_REQUEST_CAP,
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
  const companyFactsProvider = createCompanyFactsProvider(
    httpClient,
    providerRateLimiter,
  );
  const macroContextProvider = createMacroContextProvider(
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
    companyFactsProvider,
    macroContextProvider,
  );
  const normalizationService = new NormalizationService(
    documentRepo,
    llm,
    queue,
  );
  const classifyStockService = new ClassifyStockService(
    documentRepo,
    metricsRepo,
    filingsRepo,
    queue,
  );
  const selectHorizonService = new SelectHorizonService(
    metricsRepo,
    filingsRepo,
    queue,
  );
  const buildKpiTreeService = new BuildKpiTreeService(
    documentRepo,
    metricsRepo,
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
      thesisGenericPhraseMax: env.THESIS_GENERIC_PHRASE_MAX,
      thesisMinCitationCoveragePct: env.THESIS_MIN_CITATION_COVERAGE_PCT,
      thesisQualityMinScore: env.THESIS_QUALITY_MIN_SCORE,
      kpiCarryForwardMaxAgeDays: env.THESIS_KPI_CARRY_FORWARD_MAX_AGE_DAYS,
      coreKpiMinRequired: env.THESIS_CORE_KPI_MIN_REQUIRED,
      graceAllowOnSectorWeakness: env.THESIS_GRACE_ALLOW_ON_SECTOR_WEAKNESS,
      newsV2MinCompositeScore: env.NEWS_V2_MIN_COMPOSITE_SCORE,
      newsV2MinMaterialityScore: env.NEWS_V2_MIN_MATERIALITY_SCORE,
      newsV2MinKpiLinkageScore: env.NEWS_V2_MIN_KPI_LINKAGE_SCORE,
      newsV2MaxItems: env.NEWS_V2_MAX_ITEMS,
      newsV2SourceQualityMode: newsV2SourceQualityMode(),
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
    classifyStockService,
    selectHorizonService,
    buildKpiTreeService,
    embeddingService,
    synthesisService,
  };
};

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { defaultConfig } from "./defaultConfig";

const supportedNewsProviders = ["mock", "finnhub", "alphavantage"] as const;
const supportedMetricsProviders = ["mock", "alphavantage"] as const;
const supportedFilingsProviders = ["mock", "sec-edgar"] as const;
const supportedLlmProviders = ["ollama", "openai"] as const;
const supportedNewsRelevanceModes = ["high_precision", "balanced"] as const;
const supportedNewsV2SourceQualityModes = ["default"] as const;

export type NewsProviderName = (typeof supportedNewsProviders)[number];
export type MetricsProviderName = (typeof supportedMetricsProviders)[number];
export type FilingsProviderName = (typeof supportedFilingsProviders)[number];
export type LlmProviderName = (typeof supportedLlmProviders)[number];

const sensitiveEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  POSTGRES_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/research_bot"),
  FINNHUB_API_KEY: z.string().default(""),
  ALPHA_VANTAGE_API_KEY: z.string().default(""),
  SEC_EDGAR_USER_AGENT: z
    .string()
    .default("research-bot/1.0 (contact: devnull@example.com)"),
  OPENAI_API_KEY: z.string().default(""),
  APP_CONFIG_PATH: z.string().default("config.yaml"),
});

const nonSensitiveConfigSchema = z.object({
  APP_SYMBOLS: z.string(),
  APP_RESEARCH_INTERVAL_SECONDS: z.coerce.number().int().positive(),
  API_PORT: z.coerce.number().int().positive(),
  APP_NEWS_LOOKBACK_DAYS: z.coerce.number().int().positive(),
  APP_FILINGS_LOOKBACK_DAYS: z.coerce.number().int().positive(),
  NEWS_PROVIDER: z.enum(supportedNewsProviders),
  NEWS_PROVIDERS: z.string(),
  FINNHUB_BASE_URL: z.string(),
  FINNHUB_TIMEOUT_MS: z.coerce.number().int().positive(),
  FINNHUB_MIN_INTERVAL_MS: z.coerce.number().int().positive(),
  ALPHA_VANTAGE_BASE_URL: z.string(),
  ALPHA_VANTAGE_TIMEOUT_MS: z.coerce.number().int().positive(),
  ALPHA_VANTAGE_MIN_INTERVAL_MS: z.coerce.number().int().positive(),
  METRICS_PROVIDER: z.enum(supportedMetricsProviders),
  FILINGS_PROVIDER: z.enum(supportedFilingsProviders),
  SEC_EDGAR_BASE_URL: z.string(),
  SEC_EDGAR_ARCHIVES_BASE_URL: z.string(),
  SEC_EDGAR_TICKERS_URL: z.string(),
  SEC_EDGAR_TIMEOUT_MS: z.coerce.number().int().positive(),
  SEC_EDGAR_MIN_INTERVAL_MS: z.coerce.number().int().positive(),
  SEC_COMPANYFACTS_ENABLED: z.coerce.boolean(),
  SEC_COMPANYFACTS_TIMEOUT_MS: z.coerce.number().int().positive(),
  SEC_COMPANYFACTS_MAX_FACTS_PER_METRIC: z.coerce.number().int().min(1).max(128),
  LLM_PROVIDER: z.enum(supportedLlmProviders),
  OLLAMA_BASE_URL: z.string(),
  OLLAMA_CHAT_MODEL: z.string(),
  OLLAMA_EMBED_MODEL: z.string(),
  OLLAMA_CHAT_TIMEOUT_MS: z.coerce.number().int().positive(),
  OLLAMA_EMBED_TIMEOUT_MS: z.coerce.number().int().positive(),
  OPENAI_BASE_URL: z.string(),
  OPENAI_CHAT_MODEL: z.string(),
  OPENAI_CHAT_TIMEOUT_MS: z.coerce.number().int().positive(),
  NEWS_RELEVANCE_MODE: z.enum(supportedNewsRelevanceModes),
  NEWS_MIN_RELEVANCE_SCORE: z.coerce.number().int().min(1),
  NEWS_ISSUER_MATCH_MIN_FIELDS: z.coerce.number().int().min(1),
  THESIS_TRIGGER_MIN_NUMERIC: z.coerce.number().int().min(1).max(5),
  THESIS_GENERIC_PHRASE_MAX: z.coerce.number().int().min(0),
  THESIS_MIN_CITATION_COVERAGE_PCT: z.coerce.number().int().min(0).max(100),
  THESIS_QUALITY_MIN_SCORE: z.coerce.number().int().min(0).max(100),
  NEWS_V2_MIN_COMPOSITE_SCORE: z.coerce.number().int().min(0).max(100),
  NEWS_V2_MIN_MATERIALITY_SCORE: z.coerce.number().int().min(0).max(100),
  NEWS_V2_MIN_KPI_LINKAGE_SCORE: z.coerce.number().int().min(0).max(100),
  NEWS_V2_MAX_ITEMS: z.coerce.number().int().min(1).max(20),
  NEWS_V2_SOURCE_QUALITY_MODE: z.enum(supportedNewsV2SourceQualityModes),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_NORMALIZE: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_CLASSIFY_STOCK: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_SELECT_HORIZON: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_BUILD_KPI_TREE: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_EMBED: z.coerce.number().int().positive(),
  QUEUE_CONCURRENCY_SYNTHESIZE: z.coerce.number().int().positive(),
});

const toRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

/**
 * Loads gitignored YAML config to keep non-sensitive runtime knobs outside `.env`.
 */
const loadYamlConfig = (configPath: string): Record<string, unknown> => {
  const absolutePath = resolve(process.cwd(), configPath);
  if (!existsSync(absolutePath)) {
    return {};
  }

  const raw = readFileSync(absolutePath, "utf8");
  return toRecord(parseYaml(raw));
};

/**
 * Reads legacy env vars for non-sensitive keys so current environments keep working during transition.
 */
const loadNonSensitiveEnvOverrides = (): Record<string, unknown> =>
  nonSensitiveConfigSchema.partial().parse(process.env);

const sensitiveEnv = sensitiveEnvSchema.parse(process.env);
const yamlOverrides = loadYamlConfig(sensitiveEnv.APP_CONFIG_PATH);
const envOverrides = loadNonSensitiveEnvOverrides();

const nonSensitiveConfig = nonSensitiveConfigSchema.parse({
  ...defaultConfig,
  ...yamlOverrides,
  ...envOverrides,
});

const appEnvSchema = nonSensitiveConfigSchema.extend({
  NODE_ENV: sensitiveEnvSchema.shape.NODE_ENV,
  REDIS_URL: sensitiveEnvSchema.shape.REDIS_URL,
  POSTGRES_URL: sensitiveEnvSchema.shape.POSTGRES_URL,
  FINNHUB_API_KEY: sensitiveEnvSchema.shape.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: sensitiveEnvSchema.shape.ALPHA_VANTAGE_API_KEY,
  SEC_EDGAR_USER_AGENT: sensitiveEnvSchema.shape.SEC_EDGAR_USER_AGENT,
  OPENAI_API_KEY: sensitiveEnvSchema.shape.OPENAI_API_KEY,
});

export type AppEnv = z.infer<typeof appEnvSchema>;

export const env: AppEnv = appEnvSchema.parse({
  ...nonSensitiveConfig,
  NODE_ENV: sensitiveEnv.NODE_ENV,
  REDIS_URL: sensitiveEnv.REDIS_URL,
  POSTGRES_URL: sensitiveEnv.POSTGRES_URL,
  FINNHUB_API_KEY: sensitiveEnv.FINNHUB_API_KEY,
  ALPHA_VANTAGE_API_KEY: sensitiveEnv.ALPHA_VANTAGE_API_KEY,
  SEC_EDGAR_USER_AGENT: sensitiveEnv.SEC_EDGAR_USER_AGENT,
  OPENAI_API_KEY: sensitiveEnv.OPENAI_API_KEY,
});

const isRunningInContainer = (): boolean => existsSync("/.dockerenv");

const tryGetHostname = (rawUrl: string): string | null => {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Warns early when host-run commands accidentally use Docker DNS names.
 * This avoids repeated ENOTFOUND errors by pointing to the correct env profile.
 */
const warnIfHostUsesContainerDns = (appEnv: AppEnv): void => {
  if (appEnv.NODE_ENV === "test" || isRunningInContainer()) {
    return;
  }

  const redisHost = tryGetHostname(appEnv.REDIS_URL);
  const postgresHost = tryGetHostname(appEnv.POSTGRES_URL);
  const dockerOnlyHostnames = new Set(["redis", "postgres"]);

  const mismatches: string[] = [];

  if (redisHost && dockerOnlyHostnames.has(redisHost)) {
    mismatches.push(`REDIS_URL uses '${redisHost}'`);
  }

  if (postgresHost && dockerOnlyHostnames.has(postgresHost)) {
    mismatches.push(`POSTGRES_URL uses '${postgresHost}'`);
  }

  if (mismatches.length > 0) {
    console.warn(
      `[config] Host runtime detected with container DNS settings: ${mismatches.join(
        "; ",
      )}. Use .env with localhost URLs for host CLI/worker.`,
    );
  }
};

warnIfHostUsesContainerDns(env);

/**
 * Normalizes configured symbols once so scheduling logic stays deterministic across environments.
 */
export const appSymbols = (): string[] =>
  env.APP_SYMBOLS.split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

/**
 * Resolves active news providers once so runtime wiring can support both legacy single-provider and new list-based config.
 */
export const newsProviders = (): NewsProviderName[] => {
  const configured = env.NEWS_PROVIDERS.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (configured.length === 0) {
    return [env.NEWS_PROVIDER];
  }

  const validProviders = configured.filter((name): name is NewsProviderName =>
    supportedNewsProviders.includes(name as NewsProviderName),
  );

  if (validProviders.length === 0) {
    return [env.NEWS_PROVIDER];
  }

  return Array.from(new Set(validProviders));
};

/**
 * Resolves the configured market-metrics adapter so runtime wiring remains declarative and testable.
 */
export const metricsProvider = (): MetricsProviderName => env.METRICS_PROVIDER;

/**
 * Resolves the configured filings adapter so ingestion can switch providers without use-case changes.
 */
export const filingsProvider = (): FilingsProviderName => env.FILINGS_PROVIDER;

/**
 * Resolves the configured LLM adapter so runtime wiring can switch providers without use-case changes.
 */
export const llmProvider = (): LlmProviderName => env.LLM_PROVIDER;

/**
 * Resolves relevance policy mode so synthesis can choose precision/recall behavior deterministically.
 */
export const newsRelevanceMode = (): "high_precision" | "balanced" =>
  env.NEWS_RELEVANCE_MODE;

/**
 * Resolves deterministic source-quality mapping profile so scoring behavior can remain versioned and explicit.
 */
export const newsV2SourceQualityMode = (): "default" =>
  env.NEWS_V2_SOURCE_QUALITY_MODE;


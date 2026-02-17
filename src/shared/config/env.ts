import "dotenv/config";
import { existsSync } from "node:fs";
import { z } from "zod";

const supportedNewsProviders = ["mock", "finnhub", "alphavantage"] as const;
const supportedMetricsProviders = ["mock", "alphavantage"] as const;
const supportedFilingsProviders = ["mock", "sec-edgar"] as const;

export type NewsProviderName = (typeof supportedNewsProviders)[number];
export type MetricsProviderName = (typeof supportedMetricsProviders)[number];
export type FilingsProviderName = (typeof supportedFilingsProviders)[number];

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_SYMBOLS: z.string().default("AAPL,MSFT,NVDA"),
  APP_RESEARCH_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  APP_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
  // Legacy single provider config (deprecated - use NEWS_PROVIDERS for multiple providers)
  NEWS_PROVIDER: z.enum(supportedNewsProviders).default("mock"),
  // Comma-separated list of news providers (preferred over NEWS_PROVIDER)
  NEWS_PROVIDERS: z.string().default(""),
  FINNHUB_BASE_URL: z.string().default("https://finnhub.io"),
  FINNHUB_API_KEY: z.string().default(""),
  FINNHUB_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ALPHA_VANTAGE_BASE_URL: z.string().default("https://www.alphavantage.co"),
  ALPHA_VANTAGE_API_KEY: z.string().default(""),
  ALPHA_VANTAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  METRICS_PROVIDER: z.enum(supportedMetricsProviders).default("mock"),
  FILINGS_PROVIDER: z.enum(supportedFilingsProviders).default("mock"),
  SEC_EDGAR_BASE_URL: z.string().default("https://data.sec.gov"),
  SEC_EDGAR_ARCHIVES_BASE_URL: z
    .string()
    .default("https://www.sec.gov/Archives/edgar/data"),
  SEC_EDGAR_TICKERS_URL: z
    .string()
    .default("https://www.sec.gov/files/company_tickers.json"),
  SEC_EDGAR_USER_AGENT: z
    .string()
    .default("research-bot/1.0 (contact: devnull@example.com)"),
  SEC_EDGAR_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  POSTGRES_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/research_bot"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  OLLAMA_CHAT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  OLLAMA_EMBED_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_NORMALIZE: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_EMBED: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_SYNTHESIZE: z.coerce.number().int().positive().default(1),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env: AppEnv = envSchema.parse(process.env);

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

import "dotenv/config";
import { z } from "zod";

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
  REDIS_URL: z.string().default("redis://localhost:6379"),
  POSTGRES_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/research_bot"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen2.5:7b-instruct"),
  OLLAMA_EMBED_MODEL: z.string().default("nomic-embed-text"),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_NORMALIZE: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_EMBED: z.coerce.number().int().positive().default(2),
  QUEUE_CONCURRENCY_SYNTHESIZE: z.coerce.number().int().positive().default(1),
});

export type AppEnv = z.infer<typeof envSchema>;

export const env: AppEnv = envSchema.parse(process.env);

/**
 * Normalizes configured symbols once so scheduling logic stays deterministic across environments.
 */
export const appSymbols = (): string[] =>
  env.APP_SYMBOLS.split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

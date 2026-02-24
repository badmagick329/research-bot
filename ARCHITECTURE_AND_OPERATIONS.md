# Research Bot: Architecture + Operations

## 1) Architecture snapshot

### Runtime model

- Clean architecture with strict boundaries.
- Host runtime: CLI + worker + API on Bun.
- Ops console UI runtime: Vite dev server in `apps/web` (proxying `/api` to Bun API by default).
- LLM runtime is provider-selectable for chat (`ollama` or `openai`) via `LLM_PROVIDER`.
- Embedding runtime remains Ollama-backed (`OLLAMA_EMBED_MODEL`) and is independent from chat provider selection.
- Web API routing precedence:
  - if `VITE_API_BASE_URL` is set, browser requests go directly to that URL
  - if `VITE_API_BASE_URL` is empty, browser requests use relative `/api` and Vite proxy
- Infra runtime: Docker services for Postgres + Redis.
- Pipeline: `ingest -> normalize -> embed -> synthesize`.
- Stage payloads are run-scoped and carry `runId`, `taskId`, `symbol`, and diagnostics context.
- Enqueue path resolves company identity before ingestion:
  - input can be ticker (for example `RYCEY`) or mapped alias (for example `ROLLS ROYCE`)
  - payload carries `resolvedIdentity` (`requestedSymbol`, `canonicalSymbol`, `companyName`, `aliases`, `confidence`, `resolutionSource`)
- Run monitor read path is hybrid:
  - snapshot-backed run detail for terminal runs
  - queue-backed fallback for pre-snapshot `running` / `failed`

### Data + failure model

- Synthesis consumes `news + metrics + filings` evidence and writes snapshots.
- Ingestion requires at least one successful source call (`news` or `metrics` or `filings`), even when arrays are empty.
- Boundary adapters return typed `Result` errors (`provider`, `code`, `retryable`, optional `httpStatus`).
- Diagnostics are first-class and flow across stages:
  - `metricsDiagnostics`
  - `providerFailures` (news/metrics/filings)
  - `stageIssues` (normalize/embed degradation)
  - `identity` (resolved company identity)
- Stage degradation policy:
  - `ingest`: hard-fails when Alpha Vantage returns `rate_limited` (news and/or metrics), even if another source succeeds
  - `normalize`: LLM failures degrade and continue
  - `embed`: embedding failures/mismatches degrade and continue
  - `synthesize`: still runs to materialize a snapshot with explicit quality alerts
- Snapshot output surfaces:
  - resolved identity
  - data quality alerts
  - evidence-derived thesis/risks/catalysts/sources
- Web snapshot thesis rendering:
  - `snapshot.thesis` remains persisted as raw markdown text
  - UI renders markdown with GFM support and sanitization (`react-markdown`, `remark-gfm`, `rehype-sanitize`)

### Retry + idempotency model

- HTTP adapter retries: `2` (total attempts `3`).
- Provider rate limiter is Redis-backed and shared across workers/instances.
- Provider pacing defaults (free-tier safety caps):
  - Alpha Vantage: `1 request/second`
  - Finnhub: `1 request/second`
  - SEC EDGAR: `1 request/second`
- Pacing is enforced per HTTP attempt, including retries.
- BullMQ retries: `2` (total attempts `3`) with exponential backoff.
- Job idempotency key is hourly: `${symbol}-${stage}-${hour}`.
- Use `--force` to bypass idempotency dedupe for immediate reruns.
- Enqueue API responses are dedupe-aware and return queued job identity (`runId`, `taskId`) plus `deduped`.

## 2) Code map

### Composition + entrypoints

- `src/application/bootstrap/runtimeFactory.ts`
- `src/index.ts`
- `src/cli/main.ts`
- `src/workers/main.ts`

### Workflow + contracts

- `src/application/services/researchOrchestratorService.ts`
- `src/application/services/ingestionService.ts`
- `src/application/services/normalizationService.ts`
- `src/application/services/embeddingService.ts`
- `src/application/services/synthesisService.ts`
- `src/core/ports/inboundPorts.ts`
- `src/core/ports/outboundPorts.ts`
- `src/core/entities/research.ts`
- `src/core/entities/appError.ts`

### Infra adapters

- `src/infra/http/httpJsonClient.ts`
- `src/infra/queue/bullMqQueue.ts`
- `src/infra/providers/company/companyResolver.ts`
- `src/infra/providers/finnhub/finnhubNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageMetricsProvider.ts`
- `src/infra/providers/sec/secEdgarFilingsProvider.ts`
- `src/infra/llm/ollamaLlm.ts`
- `src/infra/llm/openAiLlm.ts`
- `src/infra/llm/ollamaEmbedding.ts`

### Persistence

- `src/infra/db/schema.ts`
- `src/infra/db/repositories.ts`
- `drizzle/*.sql`

### Key tests

- `src/application/services/*.test.ts`
- `src/infra/providers/**/*.test.ts`
- `src/infra/http/httpJsonClient.test.ts`
- `src/infra/queue/bullMqQueue.retry.integration.test.ts`

## 3) Operational rules

- Run CLI/worker from host terminal; Docker is only for infra services.
- `snapshot` is read-only; it never triggers pipeline execution.
- Queue names and custom job ids must not include `:`.
- Restart worker after config/code changes affecting providers/adapters/resolver map.
- Restart worker after changing provider limiter env values.
- Restart worker after changing `LLM_PROVIDER`, chat model env vars, or API keys for chat adapters.
- Embed model must match runtime/storage vector dimension expectation (currently 1024).
- For identity-sensitive investigations:
  - prefer `snapshot --prettify` to inspect `Resolved identity` and `Data quality alerts`
  - use `--force` after provider/resolver behavior changes to avoid stale idempotent jobs
- For run-monitor investigations before snapshot creation:
  - use run monitor (`/runs?runId=...`) to inspect queue-backed stage state (`queued` / `running` / `failed`)
- For web thesis readability checks:
  - verify headings/lists/links render as formatted markdown (not raw markdown text)

## 4) Migrations

### Standard workflow

1. Edit schema: `src/infra/db/schema.ts`
2. Generate migration: `bunx drizzle-kit generate`
3. Review SQL in `drizzle/`
4. Apply migration: `bun run db:migrate`

Use `migrate` (versioned SQL). Do not use `push` except local throwaway prototyping.

### Note on current identity/diagnostics changes

- Identity/diagnostics additions are stored in existing `jsonb` snapshot diagnostics payloads.
- No SQL migration is required unless table/column shape changes.
- Markdown thesis rendering change is UI-only; no migration required.

## 5) Runbook

### Prereqs

- Bun, Docker + Compose installed.
- Ollama running at `http://localhost:11434` (required for embeddings; also required for chat when `LLM_PROVIDER=ollama`).
- Required local embedding model pulled.
- If using OpenAI for chat (`LLM_PROVIDER=openai`), valid OpenAI API key available.

### Setup

1. `if (!(Test-Path .env)) { Copy-Item .env.example .env }`
2. Optional provider limiter tuning (defaults are safe for free tiers):

- `ALPHA_VANTAGE_MIN_INTERVAL_MS=1000`
- `FINNHUB_MIN_INTERVAL_MS=1000`
- `SEC_EDGAR_MIN_INTERVAL_MS=1000`

3. Select chat LLM provider:

- Ollama chat (default):
  - `LLM_PROVIDER=ollama`
  - `OLLAMA_CHAT_MODEL=qwen2.5:7b-instruct`
- OpenAI chat:
  - `LLM_PROVIDER=openai`
  - `OPENAI_API_KEY=...`
  - `OPENAI_CHAT_MODEL=gpt-4.1`
  - optional: `OPENAI_BASE_URL=https://api.openai.com`
  - optional: `OPENAI_CHAT_TIMEOUT_MS=60000`

4. `bun install`
5. `docker compose up -d postgres redis`
6. `bun run db:migrate`

### Local topology + defaults

- Web dev server: `http://localhost:5173`
- API server default: `http://localhost:3000` (`API_PORT`)
- Web proxy default target: `http://localhost:3000` (`VITE_API_PROXY_TARGET`)
- Redis default: `redis://localhost:6379`
- Postgres default: `postgres://postgres:postgres@localhost:5432/research_bot`

### Startup (3 terminals)

1. API: `bun run api`
2. Worker: `bun run worker`
3. Web: `bun run web:dev`

### Web env precedence (important)

- Recommended local default: keep `VITE_API_BASE_URL` empty in `apps/web/.env`.
- If `VITE_API_BASE_URL` is set, Vite proxy is bypassed for API calls.
- If API is not on `3000`, set `VITE_API_PROXY_TARGET` to that API URL.

### Core commands

- `bun run status`
- `bun run worker`
- `bun run api`
- `bun run web:dev`
- `bun run enqueue --symbol AAPL`
- `bun run enqueue --symbol AAPL --force`
- `bun run enqueue --symbol RYCEY --force`
- `bun run enqueue --symbol "ROLLS ROYCE" --force`
- `bun run snapshot --symbol AAPL`
- `bun run snapshot --symbol RYCEY --prettify`
- `bun run src/cli/ollamaProbe.ts`

### Maintenance

- `bun test`
- `bun run typecheck`

### Smoke test

1. Start infra + migrations.
2. Start API (`bun run api`).
3. Start worker (`bun run worker`).
4. Start web app (`bun run web:dev`).
5. Enqueue one symbol (or mapped company alias).
6. Open run monitor (`/runs?runId=...`) and confirm polling (~5s) to terminal state.
7. Fetch snapshot with `--prettify`.
8. In web snapshot view, confirm thesis markdown renders as formatted sections/lists.
9. Confirm `Resolved identity` and `Data quality alerts` sections are present when relevant.

If no snapshot appears:

- check worker logs for failed jobs
- check API process is running and reachable on expected port
- if web shows `ECONNREFUSED` for `/api/*`, align `API_PORT` and `VITE_API_PROXY_TARGET`
- if web calls wrong origin, clear or fix `VITE_API_BASE_URL`
- confirm host URLs use `localhost` for Redis/Postgres
- confirm chat provider reachability:
  - Ollama: `OLLAMA_BASE_URL`, chat model availability
  - OpenAI: `OPENAI_API_KEY`, model name, outbound network access
- confirm Ollama embedding reachability + local embedding model availability
- retry enqueue with `--force`

### v1 limitations

- Polling-only UI updates (no SSE/WebSocket).
- No AuthN/AuthZ.
- Snapshot endpoint is read-only and does not trigger pipeline execution.

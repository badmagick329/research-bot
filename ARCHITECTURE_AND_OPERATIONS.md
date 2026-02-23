# Research Bot: Architecture + Operations

## 1) Architecture snapshot

### Runtime model

- Clean architecture with strict boundaries.
- Host runtime: CLI + worker + API on Bun.
- Ops console UI runtime: Vite dev server in `apps/web` (proxying `/api` to Bun API).
- Infra runtime: Docker services for Postgres + Redis.
- Pipeline: `ingest -> normalize -> embed -> synthesize`.
- Stage payloads are run-scoped and carry: `runId`, `taskId`, `symbol`, and diagnostics context.
- Enqueue path resolves company identity before ingestion:
  - input can be ticker (for example `RYCEY`) or mapped company-name aliases (for example `ROLLS ROYCE`)
  - payload carries `resolvedIdentity` (`requestedSymbol`, `canonicalSymbol`, `companyName`, `aliases`, `confidence`, `resolutionSource`)

### Data + failure model

- Synthesis consumes `news + metrics + filings` evidence and writes snapshots.
- Ingestion requires at least one successful source call (`news` or `metrics` or `filings`), even if returned arrays are empty.
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
- Snapshot prettify output surfaces:
  - resolved identity
  - data quality alerts
  - evidence-derived thesis/risks/catalysts/sources

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

- Run CLI/worker from host terminal; Docker is for infra services only.
- `snapshot` is read-only; it never triggers pipeline execution.
- Queue names and custom job ids must not include `:`.
- Restart worker after config/code changes affecting providers/adapters/resolver map.
- Restart worker after changing provider limiter env values.
- Embed model must match runtime/storage vector dimension expectation (currently 1024).
- For identity-sensitive investigations:
  - prefer `snapshot --prettify` to inspect `Resolved identity` and `Data quality alerts`
  - use `--force` after provider/resolver behavior changes to avoid stale idempotent jobs

## 4) Migrations

### Standard workflow

1. Edit schema: `src/infra/db/schema.ts`
2. Generate migration: `bunx drizzle-kit generate`
3. Review SQL in `drizzle/`
4. Apply migration: `bun run db:migrate`

Use `migrate` (versioned SQL). Do not use `push` except local throwaway prototyping.

### Note on current identity/diagnostics changes

- The recent identity and diagnostics additions are stored inside existing `jsonb` snapshot diagnostics payloads.
- No new SQL migration is required unless table/column shape changes.

## 5) Runbook

### Prereqs

- Bun, Docker + Compose installed.
- Ollama running at `http://localhost:11434`.
- Required models pulled locally (chat + embedding).

### Setup

1. `if (!(Test-Path .env)) { Copy-Item .env.example .env }`
2. Optional provider limiter tuning (defaults are safe for free tiers):

- `ALPHA_VANTAGE_MIN_INTERVAL_MS=1000`
- `FINNHUB_MIN_INTERVAL_MS=1000`
- `SEC_EDGAR_MIN_INTERVAL_MS=1000`

3. `bun install`
4. `docker compose up -d postgres redis`
5. `bun run db:migrate`

### Core commands

- `bun run src/index.ts status`
- `bun run src/workers/main.ts`
- `bun run src/api/main.ts`
- `bun run web:dev`
- `bun run src/index.ts enqueue --symbol AAPL`
- `bun run src/index.ts enqueue --symbol AAPL --force`
- `bun run src/index.ts enqueue --symbol RYCEY --force`
- `bun run src/index.ts enqueue --symbol "ROLLS ROYCE" --force`
- `bun run src/index.ts snapshot --symbol AAPL`
- `bun run src/index.ts snapshot --symbol RYCEY --prettify`
- `bun run src/cli/ollamaProbe.ts`

### Maintenance

- `bun test`
- `bun run typecheck`

### Smoke test

1. Start infra + migrations.
2. Start API (`bun run src/api/main.ts`).
3. Start worker.
4. Start web app (`bun run web:dev`).
5. Enqueue one symbol (or mapped company alias).
6. Wait for stage completion.
7. Fetch snapshot with `--prettify`.
8. Confirm `Resolved identity` and `Data quality alerts` sections are present when relevant.

If no snapshot appears:

- check worker logs for failed jobs
- confirm host URLs use `localhost` for Redis/Postgres
- confirm Ollama reachability + local model availability
- retry enqueue with `--force`

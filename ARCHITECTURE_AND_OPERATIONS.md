# Research Bot: Architecture + Operations

## 1) Architecture snapshot

### Runtime model

- Clean architecture with strict boundaries.
- Host runtime: CLI + worker on Bun.
- Infra runtime: Docker services for Postgres + Redis.
- Pipeline: `ingest -> normalize -> embed -> synthesize`.
- Stage payloads carry `runId/taskId`; downstream reads are run-scoped.

### Data + failure model

- Synthesis consumes `news + metrics + filings` evidence and writes snapshots.
- Ingestion persists metrics diagnostics and forwards them to synthesis.
- Providers/LLM/embedding return typed `Result` boundary errors.
- Ingestion requires at least one successful source call (`news` or `metrics` or `filings`), even if evidence arrays are empty.
- Metrics policy is hybrid:
  - auth/config invalid => fail hard
  - transient/provider issues => degrade with diagnostics

### Retry + idempotency model

- HTTP adapter retries: `2` (total attempts `3`).
- BullMQ retries: `2` (total attempts `3`) with exponential backoff.
- Job idempotency is hourly (`${symbol}-${stage}-${hour}`); use `--force` to bypass.

## 2) Code map

### Composition + entrypoints

- `src/application/bootstrap/runtimeFactory.ts`
- `src/index.ts`
- `src/cli/main.ts`
- `src/workers/main.ts`

### Workflow + contracts

- `src/application/services/ingestionService.ts`
- `src/application/services/normalizationService.ts`
- `src/application/services/embeddingService.ts`
- `src/application/services/synthesisService.ts`
- `src/core/ports/inboundPorts.ts`
- `src/core/ports/outboundPorts.ts`
- `src/core/entities/appError.ts`

### Infra adapters

- `src/infra/http/httpJsonClient.ts`
- `src/infra/queue/bullMqQueue.ts`
- `src/infra/providers/finnhub/finnhubNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageMetricsProvider.ts`
- `src/infra/providers/sec/secEdgarFilingsProvider.ts`
- `src/infra/llm/ollamaLlm.ts`
- `src/infra/llm/ollamaEmbedding.ts`

### Schema + persistence

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
- Restart worker after config/code changes affecting providers/adapters.
- Embed model must match runtime/storage dimension expectation (currently 1024).

## 4) Migrations

### Standard workflow

1. Edit schema: `src/infra/db/schema.ts`
2. Generate migration: `bunx drizzle-kit generate`
3. Review SQL in `drizzle/`
4. Apply migration: `bun run db:migrate`

Use `migrate` (versioned SQL). Do not use `push` except local throwaway prototyping.

## 5) Runbook

### Prereqs

- Bun, Docker + Compose installed.
- Ollama running at `http://localhost:11434`.
- Required models pulled locally (chat + embedding).

### Setup

1. `if (!(Test-Path .env)) { Copy-Item .env.example .env }`
2. `bun install`
3. `docker compose up -d postgres redis`
4. `bun run db:migrate`

### Core commands

- `bun run src/index.ts status`
- `bun run src/index.ts enqueue --symbol AAPL`
- `bun run src/index.ts enqueue --symbol AAPL --force`
- `bun run src/index.ts snapshot --symbol AAPL`
- `bun run src/index.ts snapshot --symbol AAPL --prettify`
- `bun run src/workers/main.ts`
- `bun run src/cli/ollamaProbe.ts`

### Maintenance

- `bun test`
- `bun run typecheck`

### Smoke test

1. Start infra + migrations.
2. Start worker.
3. Enqueue one symbol.
4. Wait for stage completion.
5. Fetch snapshot.

If no snapshot appears:

- check worker logs
- confirm host URLs use `localhost` for Redis/Postgres
- confirm Ollama reachability + local model availability
- retry enqueue with `--force`

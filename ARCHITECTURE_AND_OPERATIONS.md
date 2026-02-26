# Research Bot: Architecture and Operations

## Purpose
Operator and developer reference for current runtime behavior.

## Runtime
- Host processes: Bun CLI, Bun API, Bun workers.
- Web UI: Vite app in `apps/web`.
- Infra: Postgres + Redis.
- Architecture: clean boundaries (`core` -> `application` -> `infra`).

## Pipeline
- Stages: `ingest -> normalize -> embed -> synthesize`.
- Run-scoped payload carries `runId`, `taskId`, `symbol`, diagnostics context.
- Company identity is resolved before ingestion and propagated downstream.

## Evidence Ingestion
- Ingestion persists: news, metrics, filings, market-context enrichments.
- Market-context enrichments include peer-relative valuation, earnings timing/surprise, analyst trend.
- SEC filings use bounded content parsing and deterministic extracted facts; metadata-only fallback is allowed.
- Ingestion hard-fails on Alpha Vantage `rate_limited`.
- Market-context failures are non-fatal and captured as provider failures.

## Thesis Model (Current)
- `snapshot` is read-only and never triggers pipeline execution.
- `refresh-thesis` enqueues `synthesize` only; no provider repull.
- Thesis markdown is persisted in snapshot.
- Evidence Map is deterministic and code-owned (`N#`, `M#`, `F#`, `R#`).
- News evidence is issuer-gated before relevance scoring:
  - include only if issuer identity matches ticker/company/alias/payload symbols.
  - unmatched headlines are excluded from synthesis/evidence map.
- Action Summary has deterministic overlays:
  - decision seed from policy context (`Buy|Watch|Avoid`)
  - If/Then trigger set from deterministic action matrix (threshold/action/citations)
- Validation rejects generic non-actionable trigger language and weak trigger structure.

## Diagnostics in Snapshot
- `metricsDiagnostics`
- `providerFailures` (sources: `news`, `metrics`, `filings`, `market-context`)
- `stageIssues`
- `identity`
- `newsQuality` (`total`, `issuerMatched`, `excluded`, `mode`)
- `decisionReasons` (policy reason tags)

## LLM + Embeddings
- Chat/synthesis provider: `LLM_PROVIDER` (`ollama` or `openai`).
- Embeddings remain Ollama-based.
- Cross-run memory retrieval is symbol-scoped and excludes current run.
- `R#` citations are supporting context; current-run evidence remains primary.

## Retry, Idempotency, Pacing
- HTTP retries: 2 retries (3 attempts total).
- BullMQ retries: 2 retries (3 attempts total), exponential backoff.
- Redis-backed provider pacing defaults:
  - Alpha Vantage: 1 req/sec
  - Finnhub: 1 req/sec
  - SEC EDGAR: 1 req/sec
- Queue idempotency key: `${symbol}-${stage}-${hour}`.
- `enqueue --force` bypasses hourly dedupe.

## API/Web Behavior
- Web routing:
  - if `VITE_API_BASE_URL` set -> direct calls.
  - else -> relative `/api` via Vite proxy.
- Thesis refresh endpoint:
  - `POST /api/snapshots/:symbol/refresh-thesis`
  - optional body `{ "runId": "..." }`

## Key Entrypoints
- Runtime composition: `src/application/bootstrap/runtimeFactory.ts`
- CLI: `src/cli/main.ts`
- API: `src/api/main.ts`
- Workers: `src/workers/main.ts`
- Synthesis: `src/application/services/synthesisService.ts`

## Setup + Run
1. `if (!(Test-Path .env)) { Copy-Item .env.example .env }`
2. `bun install`
3. `docker compose up -d postgres redis`
4. `bun run db:migrate`
5. Start services:
   - `bun run api`
   - `bun run worker`
   - `bun run web:dev`

## Core Commands
- `bun run enqueue --symbol AAPL`
- `bun run enqueue --symbol AAPL --force`
- `bun run refresh-thesis --symbol AAPL`
- `bun run refresh-thesis --symbol AAPL --run-id <RUN_ID>`
- `bun run snapshot --symbol AAPL --prettify`
- `bun run status`

## Important Env Knobs
- `NEWS_RELEVANCE_MODE=high_precision|balanced` (default: `high_precision`)
- `NEWS_MIN_RELEVANCE_SCORE` (default: `7`)
- `NEWS_ISSUER_MATCH_MIN_FIELDS` (default: `1`)
- `THESIS_TRIGGER_MIN_NUMERIC` (default: `3`)

## Troubleshooting
- No snapshot updates:
  - confirm API + worker are running.
  - check worker logs for stage failures.
  - rerun with `enqueue --force` if idempotency reused stale run.
- Thesis refresh expected but unchanged:
  - verify new snapshot `createdAt` is newer than prior snapshot.
  - use run monitor for synthesize stage completion.
- Web `/api/*` errors:
  - align `API_PORT`, `VITE_API_PROXY_TARGET`, `VITE_API_BASE_URL`.

## Migrations
- Workflow:
  1. edit `src/infra/db/schema.ts`
  2. `bunx drizzle-kit generate`
  3. review SQL under `drizzle/`
  4. `bun run db:migrate`
- Use versioned migrations (`migrate`), not `push` (except throwaway local prototyping).

## Current Limits
- Polling UI only (no SSE/WebSocket).
- No AuthN/AuthZ.

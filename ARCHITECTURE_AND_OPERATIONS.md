# Research Bot: Architecture + Operations

## 1) How this app is architected (and why)

### High-level design

- Style: clean architecture with strict boundaries.
- Runtime shape: host CLI (`run`/`enqueue`/`snapshot`/`status`) + host worker + infra (`postgres`, `redis`).
- Pipeline: `ingest -> normalize -> embed -> synthesize`.
- Current provider state: real news providers (Finnhub + Alpha Vantage), optional real SEC EDGAR filings, optional real Alpha Vantage metrics.

### Why this shape

- Queue stages isolate failures and retries per step.
- Core/application layers stay provider-agnostic.
- Infra adapters are replaceable (mock -> real provider) with minimal changes.
- Local-first inference (Ollama) keeps inference self-hosted.

### Sprint close-out (Feb 2026)

- Added real adapter options for filings + metrics:
  - SEC EDGAR filings provider (`FILINGS_PROVIDER=sec-edgar`)
  - Alpha Vantage metrics provider (`METRICS_PROVIDER=alphavantage`)
- Added provider contract tests for both adapters.
- Added queue observability baseline:
  - `status` now includes per-stage queue counters.
  - worker logs include stage start/completion/failure with duration and task metadata.
- Tightened embedding reliability:
  - embedding path is fail-fast on transport and dimension mismatch.
  - no silent zero-vector fallback.
- Added `embeddings` table definition to Drizzle schema source for schema/migration parity.

### Code map: what to understand first

1. Bootstrapping and wiring

- `src/application/bootstrap/runtimeFactory.ts`
- What it does: composes all concrete adapters + services.

2. CLI entry and commands
   - `src/index.ts`
   - `src/cli/main.ts`
   - What it does: command surface (`run`, `enqueue`, `snapshot`, `status`).

3. Worker process + queue stage handlers
   - `src/workers/main.ts`

- `src/infra/queue/bullMqQueue.ts`
- `src/infra/queue/queues.ts`
- What it does: consumes queue jobs and routes to application services.

4. Core contracts (ports/entities)
   - `src/core/ports/inboundPorts.ts`
   - `src/core/ports/outboundPorts.ts`
   - `src/core/entities/*`
   - What it does: defines boundaries between business logic and infrastructure.

5. Application services (business workflow)
   - `src/application/services/ingestionService.ts`
   - `src/application/services/normalizationService.ts`
   - `src/application/services/embeddingService.ts`
   - `src/application/services/synthesisService.ts`
   - `src/application/services/researchOrchestratorService.ts`

6. Persistence and schema
   - `src/infra/db/schema.ts`
   - `src/infra/db/repositories.ts`
   - `drizzle/0000_init.sql`

7. Model adapters

- `src/infra/llm/ollamaLlm.ts`
- `src/infra/llm/ollamaEmbedding.ts`

8. Inbound provider adapters

- `src/infra/providers/finnhub/finnhubNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageNewsProvider.ts`
- `src/infra/providers/alphavantage/alphaVantageMetricsProvider.ts`
- `src/infra/providers/sec/secEdgarFilingsProvider.ts`
- `src/infra/providers/multiNewsProvider.ts`
- `src/infra/providers/mocks/*`

9. Provider contract tests

- `src/infra/providers/finnhub/finnhubNewsProvider.test.ts`
- `src/infra/providers/alphavantage/alphaVantageNewsProvider.test.ts`
- `src/infra/providers/alphavantage/alphaVantageMetricsProvider.test.ts`
- `src/infra/providers/sec/secEdgarFilingsProvider.test.ts`
- `src/infra/providers/multiNewsProvider.test.ts`

### Current best-guess evolution path

1. Improve provider coverage depth (better filings section extraction and richer metric mapping).
2. Add deeper queue observability (DLQ inspection, stage latency histograms, alerting).
3. Improve synthesis reliability:
   - structured output schema
   - stronger citation tracking
   - confidence calibration.
4. Make embeddings dimension configurable per model and add migration strategy when model changes.
5. Add a dedicated migrator service in compose/CI so schema upgrades are deterministic.

### Hidden gotchas / traps

- Runtime boundary used by this repo:
  - CLI commands run from host terminal (Bun).
  - Docker is only for infra (`postgres`, `redis`).
  - Worker always runs on host terminal (`bun run src/workers/main.ts`).

- `snapshot` is read-only.
  - It returns latest stored snapshot for a symbol.
  - It does **not** trigger a new pipeline run.
  - If you see old fallback output, enqueue again and wait for a new synthesis completion.

- Queue names in BullMQ cannot contain `:`.
  - Keep queue names like `research-ingest`, not `research:ingest`.

- Custom BullMQ `jobId` values cannot contain `:`.
  - We use hyphen-delimited idempotency keys (for example `${symbol}-${stage}-${hour}` and `-force-<taskId>`).
  - Do not reintroduce colon-delimited task/idempotency keys.

- Job idempotency is hourly in current implementation.
  - Key shape is `${symbol}-${stage}-${hour}` in `TaskFactory`.
  - Re-enqueueing same symbol/stage in same hour deduplicates.
  - Use `enqueue --force` to bypass hourly dedupe when you need an immediate rerun.

- Naming convention in this codebase:
  - Only application use-cases in `src/application/services` use the `...Service` suffix.
  - Infra/shared/bootstrap components do not use `Service` suffix.

- Run migrations once as a one-shot host command.
  - Current compose no longer runs migration or scheduler automatically.
  - Use `bun run db:migrate` before starting worker/scheduler flows.

- Ollama embedding behavior is strict by design.
  - Embedding adapter now fails fast on transport failure and vector-dimension mismatch.
  - This avoids silent quality degradation when embedding model output shape drifts.
  - Defaults: `OLLAMA_CHAT_TIMEOUT_MS=180000`, `OLLAMA_EMBED_TIMEOUT_MS=30000`.
  - Worker retries via BullMQ attempts/backoff; repeated failures require model/config fix.

- Ollama model pull + dimension compatibility are operational requirements.
  - `OLLAMA_EMBED_MODEL` must exist locally (`ollama pull <model>`).
  - Current storage/runtime expects 1024-d embeddings.
  - `nomic-embed-text` currently returns 768 dimensions and will fail embed stage unless runtime/schema are migrated.

- `ivfflat` index warning with tiny data is expected.
  - pgvector may log “index created with little data”; not fatal for v0.

- Scheduler command (`run`) is an infinite loop.
  - Use one-off commands (`enqueue`, `snapshot`) for smoke tests.

## 2) Managing migrations with Drizzle for this service

### Files that matter

- `drizzle.config.ts` (schema path + output folder + DB URL)
- `src/infra/db/schema.ts` (source-of-truth schema)
- `drizzle/*.sql` (versioned migration SQL)
- `drizzle/meta/_journal.json` (migration journal)

### Recommended workflow (team-safe)

1. Edit schema in `src/infra/db/schema.ts`.
2. Generate migration SQL:
   - `bunx drizzle-kit generate`
3. Review generated SQL in `drizzle/`.
4. Apply migrations:
   - `bun run db:migrate`
5. Commit schema + SQL migration files together.

### Apply migrations in Docker (one-shot)

- Start DB/Redis first:
  - `docker compose up -d postgres redis`
- Run migration once from host terminal:
  - `bun run db:migrate`
- Then run worker on host:
  - `bun run src/workers/main.ts`

### `migrate` vs `push`

- Use `migrate` for this project (versioned, reviewable, safer).
- Use `push` only for throwaway local prototyping; avoid in shared envs.

## 3) How to run and use this app/service

### Prereqs

- Bun installed.
- Docker + Docker Compose installed.
- Ollama running on host at `http://localhost:11434`.
- Required Ollama models pulled locally:
  - chat model from `OLLAMA_CHAT_MODEL` (default `qwen2.5:7b-instruct`)
  - embed model from `OLLAMA_EMBED_MODEL` (must match runtime/storage dimension)

### First-time setup

1. Create host env file:

- PowerShell: `if (!(Test-Path .env)) { Copy-Item .env.example .env }`

2. Install deps:
   - `bun install`
3. Pull required Ollama models:

- `ollama pull qwen2.5:7b-instruct`
- `ollama pull mxbai-embed-large` (recommended for current 1024-d setup)

4. Choose news provider mode in `.env`:

- mock (default): `NEWS_PROVIDER=mock`
- real Finnhub news: `NEWS_PROVIDER=finnhub` and set `FINNHUB_API_KEY=<your_key>`
- real Alpha Vantage news: `NEWS_PROVIDER=alphavantage` and set `ALPHA_VANTAGE_API_KEY=<your_key>`
- dual-source (recommended): `NEWS_PROVIDERS=finnhub,alphavantage` and set both API keys
- precedence rule: if `NEWS_PROVIDERS` is non-empty, runtime uses that list and ignores `NEWS_PROVIDER`
- optional overrides: `FINNHUB_BASE_URL`, `FINNHUB_TIMEOUT_MS`
- optional overrides: `ALPHA_VANTAGE_BASE_URL`, `ALPHA_VANTAGE_TIMEOUT_MS`

5. Choose metrics + filings provider mode in `.env`:

- metrics mock (default): `METRICS_PROVIDER=mock`
- metrics real (Alpha Vantage): `METRICS_PROVIDER=alphavantage` and set `ALPHA_VANTAGE_API_KEY=<your_key>`
- filings mock (default): `FILINGS_PROVIDER=mock`
- filings real (SEC EDGAR): `FILINGS_PROVIDER=sec-edgar`
- required for SEC EDGAR mode: `SEC_EDGAR_USER_AGENT=<app/version (contact: you@example.com)>`
- optional SEC overrides: `SEC_EDGAR_BASE_URL`, `SEC_EDGAR_ARCHIVES_BASE_URL`, `SEC_EDGAR_TICKERS_URL`, `SEC_EDGAR_TIMEOUT_MS`

6. Start infra:
   - `docker compose up -d postgres redis`
7. Run migrations once:

- `bun run db:migrate`

8. Start execution mode (host only):

- run `bun run src/index.ts run` + `bun run src/workers/main.ts`

### Clear workflow for dual-source news (recommended)

Single execution mode only: host worker.

1. Set providers in `.env`:

- `NEWS_PROVIDERS=finnhub,alphavantage`
- optional fallback for compatibility: keep `NEWS_PROVIDER=finnhub`
- `FINNHUB_API_KEY=<your_key>`
- `ALPHA_VANTAGE_API_KEY=<your_key>`

2. Start infra:

- `docker compose up -d postgres redis`

3. Start worker on host terminal:

- `bun run src/workers/main.ts`

4. Enqueue from another host terminal:

- `bun run src/index.ts enqueue --symbol AAPL`
  - For immediate rerun in the same hour: `bun run src/index.ts enqueue --symbol AAPL --force`

5. Watch worker logs for ingest completion, then check snapshot:

- `bun run src/index.ts snapshot --symbol AAPL`

Common gotchas:

- `AAPL` is valid; `APPL` is a typo.
- `snapshot` reads latest stored result only; it does not trigger processing.
- If queue idempotency key for same symbol/stage/hour already exists, re-enqueue may dedupe.
- Use `--force` if you need to rerun the same symbol immediately.

### Useful commands

- Enqueue one symbol:
  - `bun run src/index.ts enqueue --symbol AAPL`
- Enqueue and force rerun (bypass hourly dedupe):
  - `bun run src/index.ts enqueue --symbol AAPL --force`
- Get latest snapshot:
  - `bun run src/index.ts snapshot --symbol AAPL`
- Get latest snapshot in human-readable format:
  - `bun run src/index.ts snapshot --symbol AAPL --prettify`
- Show runtime config + queue counters:
  - `bun run src/index.ts status`
- Ollama connectivity probe (same chat path as runtime):
  - `bun run src/cli/ollamaProbe.ts`
- Ollama embed API quick check (PowerShell):
  - `$body = @{ model = 'mxbai-embed-large'; input = @('test') } | ConvertTo-Json -Depth 5; $resp = Invoke-RestMethod -Uri 'http://localhost:11434/api/embed' -Method Post -ContentType 'application/json' -Body $body; $resp.embeddings[0].Count`
- Check service status:
  - `docker compose ps`

### Local (non-docker app/worker) commands

- Scheduler:
  - `bun run src/index.ts run`
- Worker:
  - `bun run src/workers/main.ts`
- Typecheck:
  - `bun run typecheck`

### Quick smoke-test flow

1. `docker compose up -d postgres redis`
2. `bun run db:migrate`
3. `bun run src/workers/main.ts`
4. `bun run src/index.ts enqueue --symbol TEST`
5. Wait 2-4 minutes (LLM stage can be slow on cold model loads).
6. `bun run src/index.ts snapshot --symbol TEST`

If snapshot says “No snapshot found”, check:

- worker logs
- host env uses `localhost` for `POSTGRES_URL` and `REDIS_URL`
- Ollama reachability (`OLLAMA_BASE_URL`)
- probe command result: `bun run src/cli/ollamaProbe.ts`
- `OLLAMA_EMBED_MODEL` is pulled locally (`ollama pull <model>`)
- embed model dimension matches current runtime/storage expectation (1024)
- idempotency collision (same symbol/stage/hour)
- if using Finnhub: `NEWS_PROVIDER=finnhub` is set and `FINNHUB_API_KEY` is non-empty
- if using Alpha Vantage: `ALPHA_VANTAGE_API_KEY` is non-empty
- if using dual mode: `NEWS_PROVIDERS=finnhub,alphavantage` is set and both API keys are non-empty

If snapshot returns an **old** result unexpectedly, check:

- `createdAt` timestamp in snapshot output
- whether you enqueued the symbol recently
- if you re-enqueued in the same hour, rerun with `--force`
- worker completion logs for `research-synthesize`

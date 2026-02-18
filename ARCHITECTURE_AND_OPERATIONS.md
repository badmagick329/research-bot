# Research Bot: Architecture + Operations

## 1) How this app is architected (and why)

### High-level design

- Style: clean architecture with strict boundaries.
- Runtime shape: host CLI (`run`/`enqueue`/`snapshot`/`status`) + host worker + infra (`postgres`, `redis`).
- Pipeline: `ingest -> normalize -> embed -> synthesize`.
- Evidence model: synthesis consumes `news + metrics + filings` and writes snapshots with source attribution.
- Lineage model: each enqueue creates a `runId`; stages carry `runId/taskId`; reads in normalize/embed/synthesize are run-scoped.
- Diagnostics model: ingestion captures provider metrics fetch diagnostics and forwards them through stage payloads; synthesis persists diagnostics into snapshots.
- Current provider state: real news providers (Finnhub + Alpha Vantage), optional real SEC EDGAR filings, optional real Alpha Vantage metrics.

### Why this shape

- Queue stages isolate failures and retries per step.
- Core/application layers stay provider-agnostic.
- Infra adapters are replaceable (mock -> real provider) with minimal changes.
- Local-first inference (Ollama) keeps inference self-hosted.

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

- what to note: synthesis now uses stricter evidence-grounded prompting, dynamic `valuationView/risks/catalysts`, and calibrated score/confidence heuristics.

6. Persistence and schema
   - `src/infra/db/schema.ts`
   - `src/infra/db/repositories.ts`

- `drizzle/0000_init.sql`
- `drizzle/0001_run_lineage_and_filing_dedupe.sql`
- `drizzle/0002_snapshot_diagnostics.sql`

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

- provider contract tests live under `src/infra/providers/**/*.test.ts`.

### Hidden gotchas / traps

- Runtime boundary used by this repo:
  - CLI commands run from host terminal (Bun).
  - Docker is only for infra (`postgres`, `redis`).
  - Worker always runs on host terminal (`bun run src/workers/main.ts`).

- `snapshot` is read-only.
  - It returns latest stored snapshot for a symbol.
  - It does **not** trigger a new pipeline run.
  - If you see old fallback output, enqueue again and wait for a new synthesis completion.
  - If code changed but snapshot still shows old behavior, the latest completed synthesis likely came from a prior worker run; enqueue again after restarting worker.

- Evidence reads are run-scoped.
  - normalize/embed/synthesize read by `symbol + runId`.
  - this prevents stale cross-run mixing during synthesis.
  - if debugging a run, trace `runId` in worker logs.

- Metrics fetch behavior is intentionally hybrid.
  - Alpha Vantage metrics adapter degrades with diagnostics on transient/provider issues (for example rate limits/timeouts/non-success responses).
  - Alpha Vantage metrics adapter fails fast on auth/config-invalid signals so retries surface real misconfiguration.
  - This prevents silent missing-metrics ambiguity while keeping most runs resilient.

- Provider/LLM/embedding failures are now explicit at port boundaries.
  - inbound providers and outbound model adapters return typed `Result` values (neverthrow) instead of masking transport failures as empty datasets or fallback prose.
  - adapters keep provider-specific internal errors and map them to one app-level boundary union.
  - ingestion applies best-effort policy across sources and degrades on partial failures.

- Ingestion now requires at least one successful source call.
  - source call success is call-level (`Result.ok`) and may still contain zero evidence rows.
  - if all three sources fail (`news + metrics + filings`), ingest stage fails and worker retry policy applies.

- Retry policy is bounded at both layers.
  - HTTP adapter retries: `2` (total attempts `3`) for providers and Ollama adapters.
  - BullMQ stage retries: `2` (total attempts `3`) with exponential backoff.
  - this intentionally allows multiplicative retries while keeping both limits small and fixed.

- Missing metrics are now explicit in snapshot diagnostics.
  - `snapshots.diagnostics.metrics` stores provider status, metric count, optional reason, and optional http status.
  - synthesis prompt includes metrics diagnostics and should explicitly call out this gap in “Missing Evidence”.
  - `snapshot --prettify` remains human-focused and does not currently render diagnostics; use raw `snapshot` output to inspect diagnostics fields.

- Filing dedupe is natural-key based.
  - storage key is `(provider, dedupe_key)`.
  - `dedupe_key` prefers accession number; fallback is symbol-scoped doc URL.
  - migration keeps latest duplicate row when collapsing historical duplicates.

- SEC filing extraction is metadata-derived at this stage.
  - filings now include compact derived `sections` and `extractedFacts` from EDGAR metadata.
  - this improves synthesis grounding versus empty filing payloads, but is not full filing body parsing yet.

- Restart worker after config/code changes that affect provider behavior.
  - a long-running worker process keeps old env/code until restarted.
  - after restart, enqueue with `--force` to ensure a fresh run in the current hour.

- Queue names in BullMQ cannot contain `:`.
  - Keep queue names like `research-ingest`, not `research:ingest`.

- Custom BullMQ `jobId` values cannot contain `:`.
  - We use hyphen-delimited idempotency keys (for example `${symbol}-${stage}-${hour}` and `-force-<taskId>`).
  - Do not reintroduce colon-delimited task/idempotency keys.

- Job idempotency is hourly in current implementation.
  - Key shape is `${symbol}-${stage}-${hour}` in `TaskFactory`.
  - Re-enqueueing same symbol/stage in same hour deduplicates.
  - Use `enqueue --force` to bypass hourly dedupe when you need an immediate rerun.

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

- Scheduler command (`run`) is an infinite loop.
  - Use one-off commands (`enqueue`, `snapshot`) for smoke tests.

## 2) Managing migrations with Drizzle for this service

### Files that matter

- `drizzle.config.ts` (schema path + output folder + DB URL)
- `src/infra/db/schema.ts` (source-of-truth schema)
- `drizzle/*.sql` (versioned migration SQL)
- `drizzle/meta/_journal.json` (migration journal)

### Current migration notes

- `0001_run_lineage_and_filing_dedupe` adds:
  - `run_id/task_id` lineage columns on evidence, embeddings, and snapshots.
  - filing `dedupe_key` + unique `(provider, dedupe_key)` index.
  - run-scope helper indexes for symbol+run read paths.

- `0002_snapshot_diagnostics` adds:
  - `snapshots.diagnostics jsonb` with default `{}`.
  - persistence for metrics fetch diagnostics (`status`, `metricCount`, optional `reason/httpStatus`) used to explain missing metrics in downstream outputs.

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
- metrics hybrid error policy note: auth/config-invalid metrics failures fail the ingest stage; transient/provider failures degrade with diagnostics and continue
- filings mock (default): `FILINGS_PROVIDER=mock`
- filings real (SEC EDGAR): `FILINGS_PROVIDER=sec-edgar`
- required for SEC EDGAR mode: `SEC_EDGAR_USER_AGENT=<app/version (contact: you@example.com)>`
- optional SEC overrides: `SEC_EDGAR_BASE_URL`, `SEC_EDGAR_ARCHIVES_BASE_URL`, `SEC_EDGAR_TICKERS_URL`, `SEC_EDGAR_TIMEOUT_MS`

6. Configure evidence windows in `.env`:

- news lookback window (default): `APP_NEWS_LOOKBACK_DAYS=7`
- filings lookback window (recommended longer): `APP_FILINGS_LOOKBACK_DAYS=90`
- rationale: filings are sparse and often absent in short windows, while news benefits from tighter recency

7. Start infra:
   - `docker compose up -d postgres redis`
8. Run migrations once:

- `bun run db:migrate`

9. Start execution mode (host only):

- run `bun run src/index.ts run` + `bun run src/workers/main.ts`

### Core commands

- Enqueue one symbol:
  - `bun run src/index.ts enqueue --symbol AAPL`
- Enqueue and force rerun (bypass hourly dedupe):
  - `bun run src/index.ts enqueue --symbol AAPL --force`
- Get latest snapshot:
  - `bun run src/index.ts snapshot --symbol AAPL`
  - note: raw snapshot output includes diagnostics metadata when present
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

### Maintenance command

- Typecheck:
  - `bun run typecheck`

### Quick smoke-test flow

1. `docker compose up -d postgres redis`
2. `bun run db:migrate`
3. `bun run src/workers/main.ts`
4. `bun run src/index.ts enqueue --symbol TEST`
5. Wait 2-4 minutes (LLM stage can be slow on cold model loads).
6. `bun run src/index.ts snapshot --symbol TEST`
7. Optional diagnostics check: `bun run src/index.ts snapshot --symbol TEST` (non-prettify) and inspect `diagnostics.metrics`

If snapshot says “No snapshot found”, check:

- worker logs
- host env uses `localhost` for `POSTGRES_URL` and `REDIS_URL`
- Ollama reachability (`OLLAMA_BASE_URL`)
- `OLLAMA_EMBED_MODEL` is pulled locally (`ollama pull <model>`)
- embed model dimension matches current runtime/storage expectation (1024)
- idempotency collision (same symbol/stage/hour)

If snapshot returns an **old** result unexpectedly, check:

- `createdAt` timestamp in snapshot output
- whether you enqueued the symbol recently
- if you re-enqueued in the same hour, rerun with `--force`
- worker completion logs for `research-synthesize`

# Research Bot: Codebase Structure + Analysis Structure

## 1) What this app is
- Event-driven equity research pipeline.
- Ingests evidence (news, metrics, filings, macro).
- Runs deterministic shaping/gating.
- Uses LLM only at synthesis boundary, with deterministic guardrails and fallback.
- Persists snapshots for API + web consumption.

---

## 2) Top-level layout

### Root
- `src/`: backend runtime.
- `apps/web/`: React + Vite ops UI.
- `drizzle/`: DB migrations.
- `notes/`: operator/research notes and plans.
- `ARCHITECTURE_AND_OPERATIONS.md`: runtime+ops quick reference.

### Backend by clean architecture
- `src/core/`
  - Entities/contracts only.
  - No infra dependencies.
  - Key files:
    - `entities/research.ts`: run/snapshot/diagnostics contracts.
    - `entities/document.ts`, `metric.ts`, `filing.ts`.
    - `ports/inboundPorts.ts`: provider/use-case interfaces.
    - `ports/outboundPorts.ts`: queue/repo/LLM/embedding interfaces.
- `src/application/`
  - Use-case services (pipeline stages + orchestration).
  - No direct vendor code.
  - Composition root in `bootstrap/runtimeFactory.ts`.
- `src/infra/`
  - Adapters: DB, queue, providers, HTTP, LLM, system ports.
  - Implements `core` ports.
- `src/cli/`, `src/api/`, `src/workers/`
  - Process entrypoints.

### Web
- `apps/web/src/routes/`
  - `EnqueueRoute.tsx`, `RunMonitorRoute.tsx`, `SnapshotRoute.tsx`.
- `apps/web/src/lib/apiClient.ts`
  - Typed client for ops API.
- Contracts reused from backend via TS path alias:
  - `@contracts/* -> ../../src/core/entities/*`.

---

## 3) Runtime processes

### CLI (`src/index.ts`, `src/cli/main.ts`)
- `run`: scheduler loop for `APP_SYMBOLS`.
- `enqueue --symbol <X> [--force]`: starts pipeline at ingest.
- `refresh-thesis --symbol <X> [--run-id <id>]`: synthesize-only rerun.
- `snapshot --symbol <X> [--prettify] [--show-raw-thesis]`.
- `status`: queue/system status.

### Worker (`src/workers/main.ts`)
- Creates stage workers for each queue.
- Executes stage services:
  - ingest, normalize, classify_stock, select_horizon, build_kpi_tree, embed, synthesize.
- Logs job lifecycle with run/task/symbol metadata.

### Ops API (`src/api/main.ts`, `src/infra/http/opsConsoleApi.ts`)
- Routes:
  - `POST /api/runs`
  - `POST /api/snapshots/:symbol/refresh-thesis`
  - `GET /api/queue/counts`
  - `GET /api/snapshots/:symbol/latest`
  - `GET /api/runs`
  - `GET /api/runs/:runId`

---

## 4) Composition root and dependency wiring

File: `src/application/bootstrap/runtimeFactory.ts`

- Creates infra adapters once.
- Wires ports to application services.
- Important wiring:
  - Queue: BullMQ (`infra/queue/bullMqQueue.ts`)
  - Repos: Postgres + pgvector (`infra/db/repositories.ts`)
  - LLM:
    - OpenAI or Ollama chat, based on config.
  - Embeddings:
    - Ollama embedding adapter.
  - Providers:
    - News: Finnhub/AlphaVantage or multi-provider aggregate.
    - Metrics: AlphaVantage.
    - Filings: SEC EDGAR.
    - Market-context: Finnhub.
    - Companyfacts: SEC companyfacts.
    - Macro: FRED/BLS via multi-provider.
  - Rate limiter:
    - Redis-backed per-provider pacing + daily AV budget.

---

## 5) Persistence model (Postgres)

Schema: `src/infra/db/schema.ts`

- `documents`
  - News + analysis docs.
  - Includes `evidenceClass` for selected/scored news.
  - Unique: `(provider, providerItemId)`.
- `metrics`
  - Numeric evidence points.
  - Unique natural key `(symbol, provider, metricName, asOf)`.
- `filings`
  - SEC filing records + extracted sections/facts.
  - Unique: `(provider, dedupeKey)`.
- `embeddings`
  - `documentId` -> vector(1024) + content.
- `snapshots`
  - Final thesis + investorViewV2 + diagnostics JSON.

---

## 6) Queue model and idempotency

- Queue names in `src/infra/queue/queues.ts`.
- Default retries:
  - 2 retries + initial attempt (3 total), exponential backoff.
- Idempotency:
  - job id = payload `idempotencyKey`.
  - default key shape comes from task factory (`symbol-stage-hour`).
  - `enqueue --force` appends force suffix to bypass dedupe.
- Queue state projection:
  - `BullMqQueue` can read run status from queue jobs for monitor pages.

---

## 7) Pipeline stage-by-stage

## Stage 1: ingest (`IngestionService`)
File: `src/application/services/ingestionService.ts`

- Fetches in parallel:
  - news
  - market metrics
  - filings
  - market context
  - SEC companyfacts
  - macro context
- Hard fail:
  - AlphaVantage `rate_limited`.
- Soft fail:
  - other provider failures captured in `providerFailures`.
- Persists:
  - `documents` (news + market-context analysis docs),
  - `metrics` (base + companyfacts + market-context + macro),
  - `filings`.
- Enqueues `normalize` with diagnostics payload.

## Stage 2: normalize (`NormalizationService`)
File: `src/application/services/normalizationService.ts`

- Fetches recent docs.
- Calls LLM summarize for a light normalization checkpoint.
- If summarize fails:
  - appends `stageIssues` (`stage=normalize`) and continues.
- Enqueues `classify_stock`.

## Stage 3: classify_stock (`ClassifyStockService`)
File: `src/application/services/classifyStockService.ts`

- Deterministic thesis type classification.
- Inputs:
  - docs + metrics + filings text/facts.
- Outputs:
  - `thesisTypeContext` (`thesisType`, reason codes, score).
- Enqueues `select_horizon`.

## Stage 4: select_horizon (`SelectHorizonService`)
File: `src/application/services/selectHorizonService.ts`

- Deterministic horizon selection.
- Uses thesis type + next event timing + filing recency.
- Outputs:
  - `horizonContext` (`0_4_weeks|1_2_quarters|1_3_years`, rationale, score).
- Enqueues `build_kpi_tree`.

## Stage 5: build_kpi_tree (`BuildKpiTreeService`)
File: `src/application/services/buildKpiTreeService.ts`

- Selects KPI template by thesis hints + evidence language.
- Computes required/optional KPI coverage.
- Outputs:
  - `kpiContext` (template, required, optional, selected, requiredHitCount).
- Enqueues `embed`.

## Stage 6: embed (`EmbeddingService`)
File: `src/application/services/embeddingService.ts`

- Embeds top documents.
- Persists vectors into pgvector table.
- If embed fails or vector count mismatches:
  - appends `stageIssues` (`stage=embed`) and continues.
- Enqueues `synthesize`.

## Stage 7: synthesize (`SynthesisService`)
File: `src/application/services/synthesisService.ts`

- Core analysis/thesis assembly stage.
- Reads docs/metrics/filings for current run.
- Applies deterministic evidence selection and decision policy.
- Calls LLM for thesis draft + optional repair.
- Applies strict validation + deterministic fallback if quality floor not met.
- Persists final snapshot with investor view + diagnostics.

---

## 8) Analysis structure (how analysis is built)

This is the important part for model behavior and output quality.

### 8.1 Evidence identity and relevance
- Identity is resolved at enqueue:
  - `requestedSymbol`, `canonicalSymbol`, `companyName`, aliases, confidence.
- News candidates are issuer-matched using:
  - title, summary, content, payload ticker hints, alias/company tokens.
- Payload-only match is hard-rejected.

### 8.2 News Scoring V2
Files:
- `src/application/services/newsScoringV2.ts`
- `src/application/services/synthesisService.ts` (selection logic)

Per-candidate outputs:
- `evidenceClass`: `issuer|peer|supply_chain|customer|industry`
- `documentClass`: `issuer_news|read_through_news|market_context|generic_market_noise`
- score components:
  - issuer match
  - economic materiality
  - novelty
  - horizon relevance
  - KPI linkage
  - source quality
- composite score + confidence band.

Hard exclusions:
- `payload_only_issuer_match`
- `duplicate_title`
- `duplicate_url`
- explicit market-wrap/listicle patterns
- prefiltered market/generic-noise classes
- very low source quality

Selection constraints:
- ranked top-K (`NEWS_V2_MAX_ITEMS`)
- if issuer candidates exist, force at least one issuer anchor
- read-through cap = 40% of selected set
- class/provider diversity nudges in rank tie handling
- zero-news output allowed

### 8.3 Metrics and filings shaping
- Metrics are deduped to latest by metric name.
- Macro metrics selected by KPI template (max 4).
- Filing fact highlights are extracted into prompt context.

### 8.4 Deterministic decision seed
- Builds `DecisionContext` from evidence strength + valuation + filing risk + anchor count.
- Produces deterministic seed `buy|watch|avoid`.
- Builds deterministic action matrix rows with thresholds + citations.

### 8.5 KPI coverage gate
- Core KPI floor checked separately from sector KPI quality.
- Possible action mapping:
  - `insufficient_evidence` on core floor failure.
  - `watch_low_quality` on sector weakness (when allowed).

### 8.6 LLM synthesis + repair + fallback
- LLM receives strict prompt structure + deterministic seeds.
- Output validation checks:
  - heading/order constraints
  - trigger quality (threshold/action semantics)
  - evidence citation linkage
- One repair pass allowed.
- If quality score below floor:
  - deterministic fallback thesis generated and persisted.

### 8.7 Investor-facing structured output
- `investorViewV2` built and persisted:
  - action, horizon, summary, variant view
  - drivers, key KPIs, catalysts, falsification
  - valuation summary
  - confidence decomposition (`data/thesis/timing`)

### 8.8 Diagnostics-first design
- Snapshot diagnostics are first-class, not incidental.
- Used for:
  - monitoring quality regressions
  - explaining sparse/weak outputs
  - debugging provider and stage degradation

---

## 9) Refresh-thesis path (synthesize-only)

Files:
- `src/application/services/refreshThesisContextBuilder.ts`
- CLI/API refresh commands

Behavior:
- Loads latest snapshot (or specific run snapshot).
- Rebuilds synthesize payload from stored context:
  - identity, horizon, KPI template/gate, diagnostics.
- Enqueues only `synthesize`.
- No provider re-fetch and no ingest mutation.

---

## 10) Config model and operational knobs

File: `src/shared/config/env.ts`

- Sensitive config from `.env`:
  - API keys, DB/Redis URLs.
- Non-sensitive config from `config.yaml` + env overrides.
- Validated via zod.
- Major categories:
  - provider selection/toggles
  - scoring thresholds
  - thesis quality gates
  - queue concurrency
  - pacing/budget controls

---

## 11) How to trace one run quickly

1. `bun run enqueue --symbol AMZN --force`
2. `bun run status` (watch queue counts)
3. `bun run snapshot --symbol AMZN --prettify --show-raw-thesis`
4. Inspect in output:
   - `newsQualityV2`
   - `readThroughQualityV2`
   - `thesisQuality`
   - `fallbackReasonCodes`
   - `evidenceGate`
   - `kpiCoverage`

---

## 12) Safe extension points

- Add/replace providers:
  - implement port in `core/ports/inboundPorts.ts`
  - wire adapter in `runtimeFactory.ts`
- Add deterministic analysis policy:
  - prefer application service + tests first
  - keep diagnostics explicit
- Avoid:
  - writing business rules directly in infra adapters
  - bypassing run/task payload propagation
  - adding hidden heuristics without diagnostics fields

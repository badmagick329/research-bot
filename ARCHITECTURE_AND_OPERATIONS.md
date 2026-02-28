# Research Bot: Architecture and Operations

## Purpose
Reference for current runtime behavior, pipeline decisions, and operational controls.

## System Shape
- Architecture: clean boundaries (`core` -> `application` -> `infra`).
- Runtime: Bun API, Bun worker(s), Bun CLI, Vite web app.
- Infra: Postgres (state) + Redis (queue + provider pacing).

## Pipeline
- Stages: `ingest -> normalize -> classify_stock -> select_horizon -> build_kpi_tree -> embed -> synthesize`.
- Runs are scoped by `runId`/`taskId`; identity is resolved once up front and propagated.
- Each stage is retryable; degraded stages persist diagnostics instead of silently failing.

## Ingestion Model
- Persisted evidence: news (`documents`), metrics (`metrics`), filings (`filings`), market-context analysis docs (`documents` type=`analysis`).
- Alpha Vantage hard-fail rule: ingestion aborts on `rate_limited`.
- Other provider failures are non-fatal when at least one source succeeds; failures are recorded in snapshot diagnostics.

## Market Context (Finnhub)
- Deterministic metric enrichment:
  - peer-relative: `peer_pe_percentile`, `peer_pe_premium_pct`, `peer_rev_growth_percentile`
  - earnings/events: `earnings_surprise_pct_last`, `earnings_event_days_to_next`
  - analyst trend: `analyst_buy_ratio`, `analyst_buy_ratio_delta_30d`, `analyst_consensus_score`
  - price context: `price_return_3m`, `price_return_6m`, `volatility_regime_score`
- Price-context (candle endpoint) is optional enrichment:
  - if unavailable due to plan/endpoint restrictions, market-context still returns `ok`
  - missing price-context is captured as diagnostics reason; other market-context signals continue

## Filings Model (SEC EDGAR)
- Filings are fetched with bounded parsing guards (timeout, bytes, type checks).
- Deterministic sections:
  - `mda_signals`, `risk_factor_signals`, `guidance_signals`, `liquidity_signals`, `capital_allocation_signals`, `legal_regulatory_signals`
- Deterministic fact flags include:
  - `mentions_guidance_update`, `mentions_demand_strength`, `mentions_margin_pressure`
  - `mentions_capex_increase`, `mentions_buyback`, `mentions_supply_constraint`
  - `mentions_regulatory_action`, `contains_quantified_outlook`
- Parse diagnostics are stored (`parse_mode`, `parse_failure_reason`); metadata-only fallback is non-fatal.

## Thesis Generation (V3)
- `snapshot` is read-only.
- `refresh-thesis` re-runs `synthesize` only (no re-ingestion).
- Evidence Map is deterministic/code-owned (`N#`, `M#`, `F#`, `R#`).
- News filtering is issuer-gated before relevance scoring:
  - match sources: title, summary, content, payload symbols, alias/company patterns
  - unmatched or low-quality items are excluded from synthesis + Evidence Map
  - exclusion reasons are tracked (`no_issuer_identity_match`, `below_relevance_threshold`, `duplicate_title`, `duplicate_url`)
- Action Summary is partially deterministic:
  - decision seed from code policy (`Buy|Watch|Avoid`)
  - trigger rows from deterministic action matrix (threshold + action + citations)
- Validation is strict on actionability:
  - rejects generic trigger language and weak/uncited triggers
  - requires threshold/action semantics in If/Then triggers
- Quality control:
  - thesis quality is scored deterministically
  - one repair attempt is allowed
  - if still below floor, deterministic fallback thesis is persisted
- Stage-1 structured output:
  - investor-facing contract is persisted as `investorViewV2`
  - diagnostics include explicit evidence-gate and citation-linkage fields

## Snapshot Diagnostics
- `metrics`
- `providerFailures` (`news|metrics|filings|market-context`)
- `stageIssues`
- `identity`
- `newsQuality`:
  - `total`, `issuerMatched`, `excluded`, `mode`, `excludedReasonsSample`
- `decisionReasons`
- `thesisQuality`:
  - `score`, `failedChecks`, `fallbackApplied`
- `evidenceGate`:
  - `passed`, `failures`, `missingFields`
- `missingFields`
- `citationCoveragePct`
- `unlinkedClaimsCount`

## LLM and Memory
- Synthesis provider: `OLLAMA` or `OPENAI`.
- Embeddings: Ollama embedding model.
- Cross-run semantic memory is symbol-scoped, current-run excluded, and cited as `R#`.
- Current-run evidence (`N/M/F`) remains primary for directional decisions.

## Queue, Retries, Rate Limits
- HTTP retries: 2 retries (3 total attempts).
- BullMQ retries: 2 retries (3 total attempts), exponential backoff.
- Default provider pacing:
  - Alpha Vantage: 1 req/sec
  - Finnhub: 1 req/sec
  - SEC EDGAR: 1 req/sec
- Stage idempotency key: `${symbol}-${stage}-${hour}`.
- `enqueue --force` bypasses hourly dedupe.

## API and Web
- Web API routing:
  - `VITE_API_BASE_URL` set -> direct
  - unset -> `/api` via Vite proxy
- Thesis refresh endpoint:
  - `POST /api/snapshots/:symbol/refresh-thesis`
  - optional body: `{ "runId": "<id>" }`

## Key Entrypoints
- Runtime wiring: `src/application/bootstrap/runtimeFactory.ts`
- Ingestion: `src/application/services/ingestionService.ts`
- Thesis-type classification: `src/application/services/classifyStockService.ts`
- Horizon selection: `src/application/services/selectHorizonService.ts`
- KPI tree builder: `src/application/services/buildKpiTreeService.ts`
- Synthesis: `src/application/services/synthesisService.ts`
- Filings provider: `src/infra/providers/sec/secEdgarFilingsProvider.ts`
- Market-context provider: `src/infra/providers/finnhub/finnhubMarketContextProvider.ts`

## Core Commands
- `bun run enqueue --symbol AAPL`
- `bun run enqueue --symbol AAPL --force`
- `bun run refresh-thesis --symbol AAPL`
- `bun run refresh-thesis --symbol AAPL --run-id <RUN_ID>`
- `bun run snapshot --symbol AAPL --prettify`
- `bun run status`

## Important Env Knobs
- `NEWS_RELEVANCE_MODE=high_precision|balanced`
- `NEWS_MIN_RELEVANCE_SCORE=7`
- `NEWS_ISSUER_MATCH_MIN_FIELDS=1`
- `THESIS_TRIGGER_MIN_NUMERIC=3`
- `THESIS_GENERIC_PHRASE_MAX=0`
- `THESIS_MIN_CITATION_COVERAGE_PCT=80`
- `THESIS_QUALITY_MIN_SCORE=75`
- `QUEUE_CONCURRENCY_CLASSIFY_STOCK=2`
- `QUEUE_CONCURRENCY_SELECT_HORIZON=2`
- `QUEUE_CONCURRENCY_BUILD_KPI_TREE=2`

## Current Limits
- Polling UI only (no SSE/WebSocket).
- No AuthN/AuthZ.

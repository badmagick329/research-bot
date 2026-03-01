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

## Companyfacts Model (SEC XBRL)
- SEC companyfacts (`/api/xbrl/companyfacts/CIK....json`) is ingested as additive metrics provider `sec-companyfacts`.
- Deterministic KPI-centric mapping includes:
  - `revenue_ttm`, `revenue_yoy`, `revenue_growth_yoy`
  - `gross_margin`, `operating_margin`, `profit_margin`
  - `eps`, `shares_basic`, `shares_diluted`, `shares_diluted_yoy_change`
  - `operating_cash_flow_ttm`, `capex_ttm`
- Mapping uses bounded fact windows, allowed filing forms, and period normalization (`annual|quarter|ttm|point_in_time`).
- Companyfacts fetch failure is non-fatal when other evidence sources succeed; diagnostics are persisted explicitly.

## Macro Overlay Model (FRED + BLS)
- Macro overlay is additive and deterministic; no hard decision gate depends on macro availability.
- Ingestion fetches FRED and BLS macro context in parallel and persists normalized points in `metrics` with `provider=fred|bls`.
- Normalized macro metrics include:
  - FRED: `macro_fed_funds_rate`, `macro_us10y_yield`, `macro_us2y_yield`, `macro_yield_curve_10y_2y`, `macro_cpi_yoy`, `macro_unemployment_rate`, `macro_industrial_production_yoy`, `macro_retail_sales_yoy`, `macro_wti_oil_price`
  - BLS: `macro_bls_cpi_yoy`, `macro_bls_unemployment_rate`
- Synthesis selects up to 4 macro metrics by KPI template to avoid generic macro dumps:
  - banks: fed funds, 10y, curve, unemployment
  - retail_consumer: cpi, bls_cpi, unemployment, retail_sales
  - semis: industrial_production, 10y, cpi
  - software_saas: 10y, fed funds, unemployment
  - energy_materials: wti, industrial_production, cpi
  - generic: fed funds, cpi, unemployment
- Macro provider failures are non-fatal and emitted in diagnostics/provider failures as `source=macro-context`.

## Thesis Generation (V3)
- `snapshot` is read-only.
- `refresh-thesis` re-runs `synthesize` only (no re-ingestion).
- Evidence Map is deterministic/code-owned (`N#`, `M#`, `F#`, `R#`).
- News filtering is issuer-gated before relevance scoring:
  - match sources: title, summary, content, payload symbols, alias/company patterns
  - unmatched or low-quality items are excluded from synthesis + Evidence Map
  - exclusion reasons are tracked (`no_issuer_identity_match`, `below_relevance_threshold`, `duplicate_title`, `duplicate_url`)
- News Scoring V2 (immediate enforcement):
  - deterministic component scores: `issuerMatchScore`, `economicMaterialityScore`, `noveltyScore`, `horizonRelevanceScore`, `kpiLinkageScore`, `sourceQualityScore`
  - deterministic composite score with hard keep/drop thresholds
  - read-through classes (`issuer|peer|supply_chain|customer|industry`) are now first-class evidence metadata
  - non-issuer evidence requires stronger thresholds (`materiality` and `kpiLinkage` above baseline gates) and an issuer anchor headline in selected set
  - read-through inclusion is capped to 40% of selected news set
  - evidence labels are class-prefixed (`N_issuer#`, `N_peer#`, `N_supply_chain#`, `N_customer#`, `N_industry#`)
- Action Summary is partially deterministic:
  - decision seed from code policy (`Buy|Watch|Avoid`)
  - trigger rows from deterministic action matrix (threshold + action + citations)
- Validation is strict on actionability:
  - rejects generic trigger language and weak/uncited triggers
  - requires threshold/action semantics in If/Then triggers
- KPI gate and grace-mode policy:
  - gate evaluates core KPI floor separately from sector KPI quality
  - `insufficient_core_kpi_items` is hard-fail and forces `insufficient_evidence`
  - `low_sector_kpi_quality` can map to `watch_low_quality` when other gates pass
  - grace mode is blocked when deterministic fallback thesis is applied
  - carried-forward KPI names (bounded by age) are diagnostics-only and never rendered into investor KPI cards
- Quality control:
  - thesis quality is scored deterministically
  - one repair attempt is allowed
  - if still below floor, deterministic fallback thesis is persisted
- Stage-1 structured output:
  - investor-facing contract is persisted as `investorViewV2`
  - diagnostics include explicit evidence-gate and citation-linkage fields

## Snapshot Diagnostics
- `metrics`
- `metricsCompanyFacts`
- `macroContext`:
  - `totalMetricCount`
  - `providers[]` (`fred|bls` status/count/reason/httpStatus)
  - `selectedForTemplate[]`
- `providerFailures` (`news|metrics|filings|market-context|macro-context`)
- `stageIssues`
- `identity`
- `newsQuality`:
  - `total`, `issuerMatched`, `excluded`, `mode`, `excludedReasonsSample`
- `newsQualityV2`:
  - `totalConsidered`, `included`, `excluded`, `averageCompositeScore`, `mode`
  - `excludedByReason`
  - `scoreBreakdownSample`
- `readThroughQualityV2`:
  - `issuerIncluded`, `peerIncluded`, `supplyChainIncluded`, `customerIncluded`, `industryIncluded`
  - `issuerAnchorPresent`
  - `excludedByClass`
  - `excludedByClassAndReason`
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
- Alpha Vantage daily budget guard:
  - shared Redis UTC-day counter enforces `ALPHA_VANTAGE_DAILY_REQUEST_CAP`
  - over-cap requests fail fast as `rate_limited` with reason `daily_budget_exhausted`
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
- Companyfacts provider: `src/infra/providers/sec/secCompanyFactsProvider.ts`
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
- `NEWS_V2_MIN_COMPOSITE_SCORE=65`
- `NEWS_V2_MIN_MATERIALITY_SCORE=50`
- `NEWS_V2_MIN_KPI_LINKAGE_SCORE=40`
- `NEWS_V2_MAX_ITEMS=10`
- `NEWS_V2_SOURCE_QUALITY_MODE=default`
- `THESIS_TRIGGER_MIN_NUMERIC=3`
- `THESIS_GENERIC_PHRASE_MAX=0`
- `THESIS_MIN_CITATION_COVERAGE_PCT=80`
- `THESIS_QUALITY_MIN_SCORE=75`
- `THESIS_KPI_CARRY_FORWARD_MAX_AGE_DAYS=90`
- `THESIS_CORE_KPI_MIN_REQUIRED=2`
- `THESIS_GRACE_ALLOW_ON_SECTOR_WEAKNESS=true|false`
- `SEC_COMPANYFACTS_ENABLED=true|false`
- `SEC_COMPANYFACTS_TIMEOUT_MS=15000`
- `SEC_COMPANYFACTS_MAX_FACTS_PER_METRIC=16`
- `MACRO_OVERLAY_ENABLED=true|false`
- `MACRO_FRED_ENABLED=true|false`
- `MACRO_BLS_ENABLED=true|false`
- `MACRO_LOOKBACK_MONTHS=24`
- `FRED_BASE_URL=https://api.stlouisfed.org`
- `FRED_TIMEOUT_MS=15000`
- `FRED_MIN_INTERVAL_MS=1000`
- `BLS_BASE_URL=https://api.bls.gov`
- `BLS_TIMEOUT_MS=15000`
- `BLS_MIN_INTERVAL_MS=1000`
- `ALPHA_VANTAGE_DAILY_REQUEST_CAP=25`
- `QUEUE_CONCURRENCY_CLASSIFY_STOCK=2`
- `QUEUE_CONCURRENCY_SELECT_HORIZON=2`
- `QUEUE_CONCURRENCY_BUILD_KPI_TREE=2`

## Current Limits
- Polling UI only (no SSE/WebSocket).
- No AuthN/AuthZ.

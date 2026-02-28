import type { Result } from "neverthrow";
import type { AppBoundaryError } from "../entities/appError";
import type {
  EnqueueRunRequest,
  EnqueueRunResponse,
  LatestSnapshotResponse,
  ListRunsQuery,
  ListRunsResponse,
  QueueCountsResponse,
  RunDetailResponse,
} from "../entities/opsConsole";
import type { ResolvedCompanyIdentity } from "../entities/research";

export type NewsSearchRequest = {
  symbol: string;
  from: Date;
  to: Date;
  limit: number;
};

export type NormalizedNewsItem = {
  id: string;
  provider: string;
  providerItemId: string;
  title: string;
  summary?: string;
  content: string;
  url: string;
  authors: string[];
  publishedAt: Date;
  language?: string;
  symbols: string[];
  topics: string[];
  sentiment?: number;
  sourceType: "api" | "rss" | "scrape";
  rawPayload: unknown;
};

export type MetricsRequest = {
  symbol: string;
  asOf?: Date;
};

export type MarketContextRequest = {
  symbol: string;
  asOf?: Date;
};

export type MacroContextRequest = {
  symbol: string;
  asOf?: Date;
};

export type NormalizedMarketMetricPoint = {
  id: string;
  provider: string;
  symbol: string;
  metricName: string;
  metricValue: number;
  metricUnit?: string;
  currency?: string;
  asOf: Date;
  periodType: "ttm" | "quarter" | "annual" | "point_in_time";
  periodStart?: Date;
  periodEnd?: Date;
  confidence?: number;
  rawPayload: unknown;
};

export type MetricsFetchStatus =
  | "ok"
  | "empty"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "auth_invalid"
  | "config_invalid"
  | "malformed_response"
  | "transport_error"
  | "invalid_json";

export type MetricsFetchDiagnostics = {
  provider: string;
  symbol: string;
  status: MetricsFetchStatus;
  metricCount: number;
  reason?: string;
  httpStatus?: number;
};

export type MetricsFetchResult = {
  metrics: NormalizedMarketMetricPoint[];
  diagnostics: MetricsFetchDiagnostics;
};

export type MarketContextMetricName =
  | "peer_pe_percentile"
  | "peer_pe_premium_pct"
  | "peer_rev_growth_percentile"
  | "earnings_surprise_pct_last"
  | "earnings_event_days_to_next"
  | "analyst_buy_ratio"
  | "analyst_buy_ratio_delta_30d"
  | "analyst_consensus_score"
  | "price_return_3m"
  | "price_return_6m"
  | "volatility_regime_score";

type MarketContextSignalBase = {
  metricName: MarketContextMetricName;
  metricValue: number;
  metricUnit?: string;
  asOf: Date;
  confidence?: number;
  rawPayload: unknown;
};

export type PeerRelativeValuationSignal = MarketContextSignalBase & {
  metricName:
    | "peer_pe_percentile"
    | "peer_pe_premium_pct"
    | "peer_rev_growth_percentile";
};

export type EarningsGuidanceSignal = MarketContextSignalBase & {
  metricName: "earnings_surprise_pct_last" | "earnings_event_days_to_next";
};

export type AnalystTrendSignal = MarketContextSignalBase & {
  metricName:
    | "analyst_buy_ratio"
    | "analyst_buy_ratio_delta_30d"
    | "analyst_consensus_score";
};

export type PriceContextSignal = MarketContextSignalBase & {
  metricName: "price_return_3m" | "price_return_6m" | "volatility_regime_score";
};

export type MarketContextFetchDiagnostics = {
  provider: string;
  symbol: string;
  status:
    | "ok"
    | "empty"
    | "rate_limited"
    | "timeout"
    | "provider_error"
    | "auth_invalid"
    | "config_invalid"
    | "malformed_response"
    | "transport_error"
    | "invalid_json";
  itemCounts: {
    peerRelativeValuation: number;
    earningsGuidance: number;
    analystTrend: number;
    priceContext: number;
  };
  reason?: string;
  httpStatus?: number;
};

export type MarketContextFetchResult = {
  peerRelativeValuation: PeerRelativeValuationSignal[];
  earningsGuidance: EarningsGuidanceSignal[];
  analystTrend: AnalystTrendSignal[];
  priceContext: PriceContextSignal[];
  diagnostics: MarketContextFetchDiagnostics;
};

export type MacroContextFetchDiagnostics = {
  provider: "fred" | "bls";
  status:
    | "ok"
    | "empty"
    | "rate_limited"
    | "timeout"
    | "provider_error"
    | "auth_invalid"
    | "config_invalid"
    | "malformed_response"
    | "transport_error"
    | "invalid_json";
  metricCount: number;
  reason?: string;
  httpStatus?: number;
};

export type MacroContextFetchResult = {
  metrics: NormalizedMarketMetricPoint[];
  diagnostics: MacroContextFetchDiagnostics[];
};

export type FilingsRequest = {
  symbol: string;
  from: Date;
  to: Date;
  limit: number;
};

export type NormalizedFiling = {
  id: string;
  provider: string;
  symbol: string;
  issuerName: string;
  filingType: string;
  accessionNo?: string;
  filedAt: Date;
  periodEnd?: Date;
  docUrl: string;
  sections: Array<{ name: string; text: string }>;
  extractedFacts: Array<{
    name: string;
    value: string;
    unit?: string;
    period?: string;
  }>;
  rawPayload: unknown;
};

export type CompanyResolveRequest = {
  symbolOrName: string;
};

export type CompanyResolveResult = {
  identity: ResolvedCompanyIdentity;
};

export interface NewsProviderPort {
  fetchArticles(
    request: NewsSearchRequest,
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>>;
}

export interface MarketMetricsProviderPort {
  fetchMetrics(
    request: MetricsRequest,
  ): Promise<Result<MetricsFetchResult, AppBoundaryError>>;
}

export interface CompanyFactsProviderPort {
  fetchCompanyFacts(
    request: MetricsRequest,
  ): Promise<Result<MetricsFetchResult, AppBoundaryError>>;
}

export interface FilingsProviderPort {
  fetchFilings(
    request: FilingsRequest,
  ): Promise<Result<NormalizedFiling[], AppBoundaryError>>;
}

export interface MarketContextProviderPort {
  fetchMarketContext(
    request: MarketContextRequest,
  ): Promise<Result<MarketContextFetchResult, AppBoundaryError>>;
}

export interface MacroContextProviderPort {
  fetchMacroContext(
    request: MacroContextRequest,
  ): Promise<Result<MacroContextFetchResult, AppBoundaryError>>;
}

export interface CompanyResolverPort {
  resolveCompany(
    request: CompanyResolveRequest,
  ): Promise<Result<CompanyResolveResult, AppBoundaryError>>;
}

/**
 * Defines enqueue command semantics so HTTP/CLI adapters can trigger runs through a stable use-case boundary.
 */
export interface RunEnqueueUseCasePort {
  enqueueRun(request: EnqueueRunRequest): Promise<EnqueueRunResponse>;
}

/**
 * Defines read operations needed by the ops console while keeping transport concerns outside application logic.
 */
export interface RunQueryUseCasePort {
  getQueueCounts(): Promise<QueueCountsResponse>;
  getLatestSnapshot(symbol: string): Promise<LatestSnapshotResponse | null>;
  listRuns(query: ListRunsQuery): Promise<ListRunsResponse>;
  getRunDetail(runId: string): Promise<RunDetailResponse | null>;
}

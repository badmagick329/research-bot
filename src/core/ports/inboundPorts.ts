import type { Result } from "neverthrow";
import type { AppBoundaryError } from "../entities/appError";
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
  | "malformed_response";

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

export interface FilingsProviderPort {
  fetchFilings(
    request: FilingsRequest,
  ): Promise<Result<NormalizedFiling[], AppBoundaryError>>;
}

export interface CompanyResolverPort {
  resolveCompany(
    request: CompanyResolveRequest,
  ): Promise<Result<CompanyResolveResult, AppBoundaryError>>;
}

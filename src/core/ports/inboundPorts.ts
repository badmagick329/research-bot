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

export interface NewsProviderPort {
  fetchArticles(request: NewsSearchRequest): Promise<NormalizedNewsItem[]>;
}

export interface MarketMetricsProviderPort {
  fetchMetrics(request: MetricsRequest): Promise<NormalizedMarketMetricPoint[]>;
}

export interface FilingsProviderPort {
  fetchFilings(request: FilingsRequest): Promise<NormalizedFiling[]>;
}

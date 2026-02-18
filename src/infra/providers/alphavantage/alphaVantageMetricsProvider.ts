import type {
  MarketMetricsProviderPort,
  MetricsFetchResult,
  MetricsRequest,
  NormalizedMarketMetricPoint,
} from "../../../core/ports/inboundPorts";

type AlphaVantageOverviewResponse = {
  Symbol?: string;
  Currency?: string;
  MarketCapitalization?: string;
  PERatio?: string;
  PriceToBookRatio?: string;
  DividendYield?: string;
  EPS?: string;
  ProfitMargin?: string;
  RevenueTTM?: string;
  EBITDA?: string;
  QuarterlyRevenueGrowthYOY?: string;
  Information?: string;
  Note?: string;
  "Error Message"?: string;
};

type MetricMapping = {
  field: keyof AlphaVantageOverviewResponse;
  metricName: string;
  periodType: NormalizedMarketMetricPoint["periodType"];
  metricUnit?: string;
};

const metricMappings: MetricMapping[] = [
  {
    field: "MarketCapitalization",
    metricName: "market_cap",
    periodType: "point_in_time",
    metricUnit: "usd",
  },
  {
    field: "PERatio",
    metricName: "price_to_earnings",
    periodType: "point_in_time",
    metricUnit: "multiple",
  },
  {
    field: "PriceToBookRatio",
    metricName: "price_to_book",
    periodType: "point_in_time",
    metricUnit: "multiple",
  },
  {
    field: "DividendYield",
    metricName: "dividend_yield",
    periodType: "point_in_time",
    metricUnit: "ratio",
  },
  {
    field: "EPS",
    metricName: "eps",
    periodType: "ttm",
    metricUnit: "usd",
  },
  {
    field: "ProfitMargin",
    metricName: "profit_margin",
    periodType: "ttm",
    metricUnit: "ratio",
  },
  {
    field: "RevenueTTM",
    metricName: "revenue",
    periodType: "ttm",
    metricUnit: "usd",
  },
  {
    field: "EBITDA",
    metricName: "ebitda",
    periodType: "ttm",
    metricUnit: "usd",
  },
  {
    field: "QuarterlyRevenueGrowthYOY",
    metricName: "revenue_growth_yoy",
    periodType: "quarter",
    metricUnit: "ratio",
  },
];

const parseNumericValue = (raw: string | undefined): number | null => {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
};

const fatalAuthErrorPrefix = "ALPHAVANTAGE_METRICS_FATAL_AUTH:";

/**
 * Adapts Alpha Vantage fundamentals payloads into normalized metric points for ingestion.
 */
export class AlphaVantageMetricsProvider implements MarketMetricsProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "ALPHA_VANTAGE_API_KEY is required when Alpha Vantage metrics provider is enabled.",
      );
    }
  }

  /**
   * Returns normalized metrics and yields an empty set on upstream faults so ingestion can continue.
   */
  async fetchMetrics(request: MetricsRequest): Promise<MetricsFetchResult> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();

    const url = new URL("/query", this.baseUrl);
    url.searchParams.set("function", "OVERVIEW");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", this.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const diagnosticsBase = {
      provider: "alphavantage",
      symbol,
    } as const;

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`${fatalAuthErrorPrefix} status ${response.status}`);
        }

        if (response.status === 429) {
          return {
            metrics: [],
            diagnostics: {
              ...diagnosticsBase,
              status: "rate_limited",
              metricCount: 0,
              httpStatus: response.status,
              reason: "Alpha Vantage rate limit reached",
            },
          };
        }

        return {
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: "provider_error",
            metricCount: 0,
            httpStatus: response.status,
            reason: "Alpha Vantage returned non-success status",
          },
        };
      }

      const payload = (await response.json()) as AlphaVantageOverviewResponse;
      if (!payload || typeof payload !== "object") {
        return {
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: "malformed_response",
            metricCount: 0,
            reason: "Overview payload was not an object",
          },
        };
      }

      const note = payload.Note?.trim() || payload.Information?.trim();
      if (note) {
        const isRateLimit = /rate|frequency|limit|calls per minute/i.test(note);

        return {
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: isRateLimit ? "rate_limited" : "provider_error",
            metricCount: 0,
            reason: note,
          },
        };
      }

      const errorMessage = payload["Error Message"]?.trim();
      if (errorMessage) {
        const isAuthError =
          /api key|invalid api call|unauthorized|authentication/i.test(
            errorMessage,
          );

        if (isAuthError) {
          throw new Error(`${fatalAuthErrorPrefix} ${errorMessage}`);
        }

        return {
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: "provider_error",
            metricCount: 0,
            reason: errorMessage,
          },
        };
      }

      const currency = payload.Currency?.trim() || "USD";

      const metrics: NormalizedMarketMetricPoint[] = [];

      for (const mapping of metricMappings) {
        const metricValue = parseNumericValue(payload[mapping.field]);
        if (metricValue === null) {
          continue;
        }

        metrics.push({
          id: `alphavantage-${symbol}-${mapping.metricName}-${asOf.toISOString()}`,
          provider: "alphavantage",
          symbol,
          metricName: mapping.metricName,
          metricValue,
          metricUnit: mapping.metricUnit,
          currency,
          asOf,
          periodType: mapping.periodType,
          confidence: 0.85,
          rawPayload: payload,
        });
      }

      return {
        metrics,
        diagnostics: {
          ...diagnosticsBase,
          status: metrics.length > 0 ? "ok" : "empty",
          metricCount: metrics.length,
          reason:
            metrics.length > 0
              ? undefined
              : "No numeric overview fundamentals were available for this symbol",
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith(fatalAuthErrorPrefix)
      ) {
        throw error;
      }

      const isTimeoutError =
        error instanceof DOMException && error.name === "AbortError";

      return {
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: isTimeoutError ? "timeout" : "provider_error",
          metricCount: 0,
          reason:
            error instanceof Error
              ? error.message
              : "Alpha Vantage metrics request failed",
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

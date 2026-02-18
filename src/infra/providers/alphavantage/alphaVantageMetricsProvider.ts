import type {
  MarketMetricsProviderPort,
  MetricsFetchResult,
  MetricsRequest,
  NormalizedMarketMetricPoint,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../../http/httpJsonClient";

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

/**
 * Adapts Alpha Vantage fundamentals payloads into normalized metric points for ingestion.
 */
export class AlphaVantageMetricsProvider implements MarketMetricsProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
    private readonly httpClient = new HttpJsonClient(),
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
  async fetchMetrics(
    request: MetricsRequest,
  ): Promise<Result<MetricsFetchResult, AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();

    const url = new URL("/query", this.baseUrl);
    url.searchParams.set("function", "OVERVIEW");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", this.apiKey);

    const diagnosticsBase = {
      provider: "alphavantage",
      symbol,
    } as const;

    const response =
      await this.httpClient.requestJson<AlphaVantageOverviewResponse>({
        url: url.toString(),
        method: "GET",
        timeoutMs: this.timeoutMs,
        retries: 2,
        retryDelayMs: 250,
      });

    if (response.isErr()) {
      const status = response.error.httpStatus;

      if (status === 401 || status === 403) {
        return err({
          source: "metrics",
          code: "auth_invalid",
          provider: "alphavantage",
          message: `Alpha Vantage auth failed with status ${status}.`,
          retryable: false,
          httpStatus: status,
          cause: response.error.cause,
        });
      }

      if (status === 429) {
        return ok({
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: "rate_limited",
            metricCount: 0,
            httpStatus: status,
            reason: "Alpha Vantage rate limit reached",
          },
        });
      }

      if (response.error.code === "timeout") {
        return ok({
          metrics: [],
          diagnostics: {
            ...diagnosticsBase,
            status: "timeout",
            metricCount: 0,
            reason: response.error.message,
          },
        });
      }

      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: "provider_error",
          metricCount: 0,
          httpStatus: status,
          reason: response.error.message,
        },
      });
    }

    const payload = response.value;
    if (!payload || typeof payload !== "object") {
      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: "malformed_response",
          metricCount: 0,
          reason: "Overview payload was not an object",
        },
      });
    }

    const note = payload.Note?.trim() || payload.Information?.trim();
    if (note) {
      const isRateLimit = /rate|frequency|limit|calls per minute/i.test(note);

      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: isRateLimit ? "rate_limited" : "provider_error",
          metricCount: 0,
          reason: note,
        },
      });
    }

    const errorMessage = payload["Error Message"]?.trim();
    if (errorMessage) {
      const isAuthError =
        /api key|invalid api call|unauthorized|authentication/i.test(
          errorMessage,
        );

      if (isAuthError) {
        return err({
          source: "metrics",
          code: "auth_invalid",
          provider: "alphavantage",
          message: errorMessage,
          retryable: false,
        });
      }

      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: "provider_error",
          metricCount: 0,
          reason: errorMessage,
        },
      });
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

    return ok({
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
    });
  }
}

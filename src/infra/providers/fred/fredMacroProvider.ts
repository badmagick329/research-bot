import { err, ok, type Result } from "neverthrow";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type {
  MacroContextFetchResult,
  MacroContextProviderPort,
  MacroContextRequest,
  NormalizedMarketMetricPoint,
} from "../../../core/ports/inboundPorts";
import type { ProviderRateLimiterPort } from "../../../core/ports/outboundPorts";
import { HttpJsonClient } from "../../http/httpJsonClient";

const noOpRateLimiter: ProviderRateLimiterPort = {
  waitForSlot: async () => {},
};

type FredObservation = {
  date?: string;
  value?: string;
};

type FredObservationsResponse = {
  observations?: FredObservation[];
};

type FredSeriesDefinition = {
  seriesId: string;
  metricName:
    | "macro_fed_funds_rate"
    | "macro_us10y_yield"
    | "macro_us2y_yield"
    | "macro_cpi_yoy"
    | "macro_unemployment_rate"
    | "macro_industrial_production_yoy"
    | "macro_retail_sales_yoy"
    | "macro_wti_oil_price";
  unit: string;
  deriveYoy: boolean;
  confidence: number;
};

const fredSeriesDefinitions: FredSeriesDefinition[] = [
  {
    seriesId: "FEDFUNDS",
    metricName: "macro_fed_funds_rate",
    unit: "pct",
    deriveYoy: false,
    confidence: 0.8,
  },
  {
    seriesId: "DGS10",
    metricName: "macro_us10y_yield",
    unit: "pct",
    deriveYoy: false,
    confidence: 0.8,
  },
  {
    seriesId: "DGS2",
    metricName: "macro_us2y_yield",
    unit: "pct",
    deriveYoy: false,
    confidence: 0.8,
  },
  {
    seriesId: "CPIAUCSL",
    metricName: "macro_cpi_yoy",
    unit: "pct",
    deriveYoy: true,
    confidence: 0.7,
  },
  {
    seriesId: "UNRATE",
    metricName: "macro_unemployment_rate",
    unit: "pct",
    deriveYoy: false,
    confidence: 0.78,
  },
  {
    seriesId: "INDPRO",
    metricName: "macro_industrial_production_yoy",
    unit: "pct",
    deriveYoy: true,
    confidence: 0.68,
  },
  {
    seriesId: "RSAFS",
    metricName: "macro_retail_sales_yoy",
    unit: "pct",
    deriveYoy: true,
    confidence: 0.68,
  },
  {
    seriesId: "DCOILWTICO",
    metricName: "macro_wti_oil_price",
    unit: "usd_per_bbl",
    deriveYoy: false,
    confidence: 0.76,
  },
];

type MacroPoint = {
  date: Date;
  value: number;
};

/**
 * Adapts FRED time-series observations into deterministic macro metric points.
 */
export class FredMacroProvider implements MacroContextProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
    private readonly lookbackMonths = 24,
    private readonly httpClient = new HttpJsonClient(),
    private readonly providerRateLimiter: ProviderRateLimiterPort = noOpRateLimiter,
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "FRED_API_KEY is required when FRED macro provider is enabled.",
      );
    }
  }

  /**
   * Fetches configured FRED series and maps latest level/YoY values into normalized metric points.
   */
  async fetchMacroContext(
    request: MacroContextRequest,
  ): Promise<Result<MacroContextFetchResult, AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();
    const startDate = new Date(asOf);
    startDate.setUTCMonth(startDate.getUTCMonth() - this.lookbackMonths);

    const seriesResponses = await Promise.all(
      fredSeriesDefinitions.map(async (definition) => {
        const fetchResult = await this.fetchSeries(
          definition.seriesId,
          startDate,
          asOf,
        );
        return { definition, fetchResult };
      }),
    );

    const failed = seriesResponses.find(
      (item) => item.fetchResult.isErr(),
    ) as
      | {
          definition: FredSeriesDefinition;
          fetchResult: Result<MacroPoint[], AppBoundaryError>;
        }
      | undefined;
    if (failed?.fetchResult.isErr()) {
      return err(failed.fetchResult.error);
    }

    const metrics: NormalizedMarketMetricPoint[] = [];
    seriesResponses.forEach(({ definition, fetchResult }) => {
      if (fetchResult.isErr()) {
        return;
      }
      const points = fetchResult.value;
      const metricPoint = definition.deriveYoy
        ? this.toYoyMetric(definition, points, symbol, asOf)
        : this.toLevelMetric(definition, points, symbol, asOf);
      if (metricPoint) {
        metrics.push(metricPoint);
      }
    });

    const latest10y = metrics.find(
      (metric) => metric.metricName === "macro_us10y_yield",
    );
    const latest2y = metrics.find(
      (metric) => metric.metricName === "macro_us2y_yield",
    );
    if (latest10y && latest2y) {
      metrics.push({
        id: `fred-${symbol}-macro_yield_curve_10y_2y-${asOf.toISOString()}`,
        provider: "fred",
        symbol,
        metricName: "macro_yield_curve_10y_2y",
        metricValue: Number(
          (latest10y.metricValue - latest2y.metricValue).toFixed(4),
        ),
        metricUnit: "pct",
        currency: "USD",
        asOf,
        periodType: "point_in_time",
        confidence: 0.72,
        rawPayload: {
          source: "fred",
          from: latest10y.metricName,
          subtract: latest2y.metricName,
        },
      });
    }

    return ok({
      metrics,
      diagnostics: [
        {
          provider: "fred",
          status: metrics.length > 0 ? "ok" : "empty",
          metricCount: metrics.length,
          reason:
            metrics.length > 0
              ? undefined
              : "No usable macro points were produced from configured FRED series.",
        },
      ],
    });
  }

  /**
   * Fetches one FRED series observation window with provider pacing and normalized error mapping.
   */
  private async fetchSeries(
    seriesId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Result<MacroPoint[], AppBoundaryError>> {
    const url = new URL("/fred/series/observations", this.baseUrl);
    url.searchParams.set("series_id", seriesId);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("observation_start", startDate.toISOString().slice(0, 10));
    url.searchParams.set("observation_end", endDate.toISOString().slice(0, 10));
    url.searchParams.set("sort_order", "desc");
    url.searchParams.set("limit", "260");

    const response = await this.httpClient.requestJson<FredObservationsResponse>({
      url: url.toString(),
      method: "GET",
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 250,
      beforeAttempt: async () => {
        await this.providerRateLimiter.waitForSlot("fred");
      },
    });

    if (response.isErr()) {
      return err({
        source: "metrics",
        code: this.mapHttpCode(response.error.httpStatus, response.error.code),
        provider: "fred",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    const observations = response.value.observations;
    if (!Array.isArray(observations)) {
      return err({
        source: "metrics",
        code: "malformed_response",
        provider: "fred",
        message: "FRED observations payload was malformed.",
        retryable: false,
      });
    }

    const points = observations
      .map((observation) => {
        const date = observation.date ? new Date(observation.date) : null;
        const valueRaw = observation.value?.trim() ?? "";
        const value =
          valueRaw === "." ? Number.NaN : Number.parseFloat(valueRaw);
        if (!date || !Number.isFinite(date.getTime()) || !Number.isFinite(value)) {
          return null;
        }
        return { date, value };
      })
      .filter((point): point is MacroPoint => Boolean(point))
      .sort((left, right) => right.date.getTime() - left.date.getTime());

    return ok(points);
  }

  /**
   * Converts latest level points into a point-in-time normalized macro metric.
   */
  private toLevelMetric(
    definition: FredSeriesDefinition,
    points: MacroPoint[],
    symbol: string,
    asOf: Date,
  ): NormalizedMarketMetricPoint | null {
    const latest = points[0];
    if (!latest) {
      return null;
    }

    return {
      id: `fred-${symbol}-${definition.metricName}-${latest.date.toISOString()}`,
      provider: "fred",
      symbol,
      metricName: definition.metricName,
      metricValue: Number(latest.value.toFixed(4)),
      metricUnit: definition.unit,
      currency: "USD",
      asOf,
      periodType: "point_in_time",
      confidence: definition.confidence,
      rawPayload: { source: "fred", derived: false },
    };
  }

  /**
   * Converts monthly series into deterministic year-over-year percent-change metrics.
   */
  private toYoyMetric(
    definition: FredSeriesDefinition,
    points: MacroPoint[],
    symbol: string,
    asOf: Date,
  ): NormalizedMarketMetricPoint | null {
    const latest = points[0];
    const baseline = points[12];
    if (!latest || !baseline || baseline.value === 0) {
      return null;
    }

    const yoy = ((latest.value - baseline.value) / Math.abs(baseline.value)) * 100;
    return {
      id: `fred-${symbol}-${definition.metricName}-${latest.date.toISOString()}`,
      provider: "fred",
      symbol,
      metricName: definition.metricName,
      metricValue: Number(yoy.toFixed(4)),
      metricUnit: definition.unit,
      currency: "USD",
      asOf,
      periodType: "point_in_time",
      confidence: Math.max(0.55, definition.confidence - 0.08),
      rawPayload: {
        source: "fred",
        derived: "yoy",
        latestDate: latest.date.toISOString().slice(0, 10),
        baselineDate: baseline.date.toISOString().slice(0, 10),
      },
    };
  }

  /**
   * Maps HTTP/client failures to boundary error categories used by ingestion diagnostics.
   */
  private mapHttpCode(
    httpStatus: number | undefined,
    code: "timeout" | "transport_error" | "non_success_status" | "invalid_json",
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }
    if (code === "timeout") {
      return "timeout";
    }
    if (code === "invalid_json") {
      return "invalid_json";
    }
    if (code === "transport_error") {
      return "transport_error";
    }
    return "provider_error";
  }
}

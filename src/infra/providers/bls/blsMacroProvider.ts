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

type BlsSeriesDataPoint = {
  year?: string;
  period?: string;
  value?: string;
};

type BlsSeriesPayload = {
  seriesID?: string;
  data?: BlsSeriesDataPoint[];
};

type BlsApiResponse = {
  status?: string;
  message?: string[];
  Results?: {
    series?: BlsSeriesPayload[];
  };
};

type BlsSeriesDefinition = {
  seriesId: string;
  metricName: "macro_bls_cpi_yoy" | "macro_bls_unemployment_rate";
  unit: "pct";
  deriveYoy: boolean;
  confidence: number;
};

const blsSeriesDefinitions: BlsSeriesDefinition[] = [
  {
    seriesId: "LNS14000000",
    metricName: "macro_bls_unemployment_rate",
    unit: "pct",
    deriveYoy: false,
    confidence: 0.78,
  },
  {
    seriesId: "CUUR0000SA0",
    metricName: "macro_bls_cpi_yoy",
    unit: "pct",
    deriveYoy: true,
    confidence: 0.7,
  },
];

type BlsPoint = {
  date: Date;
  value: number;
};

/**
 * Adapts BLS time-series payloads into deterministic macro metric points.
 */
export class BlsMacroProvider implements MacroContextProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey = "",
    private readonly timeoutMs = 15_000,
    private readonly lookbackMonths = 24,
    private readonly httpClient = new HttpJsonClient(),
    private readonly providerRateLimiter: ProviderRateLimiterPort = noOpRateLimiter,
  ) {}

  /**
   * Fetches configured BLS series and maps latest level/YoY values into normalized metrics.
   */
  async fetchMacroContext(
    request: MacroContextRequest,
  ): Promise<Result<MacroContextFetchResult, AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();
    const start = new Date(asOf);
    start.setUTCMonth(start.getUTCMonth() - this.lookbackMonths);

    const payloadResult = await this.fetchSeries(
      blsSeriesDefinitions.map((definition) => definition.seriesId),
      start,
      asOf,
    );
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const seriesById = new Map<string, BlsPoint[]>();
    payloadResult.value.forEach((series) => {
      if (!series.seriesID) {
        return;
      }
      seriesById.set(series.seriesID, this.mapSeriesPoints(series));
    });

    const metrics: NormalizedMarketMetricPoint[] = [];
    blsSeriesDefinitions.forEach((definition) => {
      const points = seriesById.get(definition.seriesId) ?? [];
      const metric = definition.deriveYoy
        ? this.toYoyMetric(definition, points, symbol, asOf)
        : this.toLevelMetric(definition, points, symbol, asOf);
      if (metric) {
        metrics.push(metric);
      }
    });

    return ok({
      metrics,
      diagnostics: [
        {
          provider: "bls",
          status: metrics.length > 0 ? "ok" : "empty",
          metricCount: metrics.length,
          reason:
            metrics.length > 0
              ? undefined
              : "No usable macro points were produced from configured BLS series.",
        },
      ],
    });
  }

  /**
   * Requests BLS series data in one batch and normalizes transport/auth/response failures.
   */
  private async fetchSeries(
    seriesIds: string[],
    startDate: Date,
    endDate: Date,
  ): Promise<Result<BlsSeriesPayload[], AppBoundaryError>> {
    const url = new URL("/publicAPI/v2/timeseries/data/", this.baseUrl).toString();
    const response = await this.httpClient.requestJson<BlsApiResponse>({
      url,
      method: "POST",
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 250,
      beforeAttempt: async () => {
        await this.providerRateLimiter.waitForSlot("bls");
      },
      body: {
        seriesid: seriesIds,
        startyear: String(startDate.getUTCFullYear()),
        endyear: String(endDate.getUTCFullYear()),
        registrationkey: this.apiKey || undefined,
      },
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (response.isErr()) {
      return err({
        source: "metrics",
        code: this.mapHttpCode(response.error.httpStatus, response.error.code),
        provider: "bls",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    const payload = response.value;
    if (payload.status !== "REQUEST_SUCCEEDED") {
      const reason = payload.message?.join("; ") ?? "BLS request failed.";
      return err({
        source: "metrics",
        code: /invalid|not authorized|key/i.test(reason)
          ? "auth_invalid"
          : "provider_error",
        provider: "bls",
        message: reason,
        retryable: false,
      });
    }

    const series = payload.Results?.series;
    if (!Array.isArray(series)) {
      return err({
        source: "metrics",
        code: "malformed_response",
        provider: "bls",
        message: "BLS series payload was malformed.",
        retryable: false,
      });
    }

    return ok(series);
  }

  /**
   * Converts BLS monthly rows into time-ordered numeric points for deterministic metric derivation.
   */
  private mapSeriesPoints(series: BlsSeriesPayload): BlsPoint[] {
    const rows = Array.isArray(series.data) ? series.data : [];
    return rows
      .map((row) => {
        const year = Number.parseInt(row.year ?? "", 10);
        const period = row.period ?? "";
        if (!Number.isFinite(year) || !/^M(0[1-9]|1[0-2])$/.test(period)) {
          return null;
        }
        const month = Number.parseInt(period.slice(1), 10);
        const value = Number.parseFloat(row.value ?? "");
        if (!Number.isFinite(value)) {
          return null;
        }
        const date = new Date(Date.UTC(year, month - 1, 1));
        return { date, value };
      })
      .filter((point): point is BlsPoint => Boolean(point))
      .sort((left, right) => right.date.getTime() - left.date.getTime());
  }

  /**
   * Converts latest level point into a point-in-time macro metric.
   */
  private toLevelMetric(
    definition: BlsSeriesDefinition,
    points: BlsPoint[],
    symbol: string,
    asOf: Date,
  ): NormalizedMarketMetricPoint | null {
    const latest = points[0];
    if (!latest) {
      return null;
    }
    return {
      id: `bls-${symbol}-${definition.metricName}-${latest.date.toISOString()}`,
      provider: "bls",
      symbol,
      metricName: definition.metricName,
      metricValue: Number(latest.value.toFixed(4)),
      metricUnit: definition.unit,
      currency: "USD",
      asOf,
      periodType: "point_in_time",
      confidence: definition.confidence,
      rawPayload: { source: "bls", derived: false },
    };
  }

  /**
   * Converts monthly level series to deterministic year-over-year percentage change.
   */
  private toYoyMetric(
    definition: BlsSeriesDefinition,
    points: BlsPoint[],
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
      id: `bls-${symbol}-${definition.metricName}-${latest.date.toISOString()}`,
      provider: "bls",
      symbol,
      metricName: definition.metricName,
      metricValue: Number(yoy.toFixed(4)),
      metricUnit: definition.unit,
      currency: "USD",
      asOf,
      periodType: "point_in_time",
      confidence: Math.max(0.55, definition.confidence - 0.08),
      rawPayload: {
        source: "bls",
        derived: "yoy",
        latestDate: latest.date.toISOString().slice(0, 10),
        baselineDate: baseline.date.toISOString().slice(0, 10),
      },
    };
  }

  /**
   * Maps HTTP/client failures to boundary categories consumed by ingestion degradation policy.
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

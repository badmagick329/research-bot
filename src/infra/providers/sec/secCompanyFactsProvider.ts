import type {
  CompanyFactsProviderPort,
  MetricsFetchResult,
  MetricsRequest,
  NormalizedMarketMetricPoint,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type { ProviderRateLimiterPort } from "../../../core/ports/outboundPorts";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../../http/httpJsonClient";

const noOpRateLimiter: ProviderRateLimiterPort = {
  waitForSlot: async () => {},
};

type EdgarTickerRecord = {
  ticker?: string;
  cik_str?: number;
};

type EdgarTickersResponse = Record<string, EdgarTickerRecord>;

type CompanyFactsPoint = {
  val?: number;
  end?: string;
  start?: string;
  form?: string;
  fy?: number;
  fp?: string;
};

type CompanyFactsTag = {
  units?: Record<string, CompanyFactsPoint[]>;
};

type CompanyFactsResponse = {
  facts?: Record<string, Record<string, CompanyFactsTag>>;
};

type DirectMetricDefinition = {
  metricName: string;
  confidence: number;
  unitCandidates: string[];
  tags: Array<{ taxonomy: string; tag: string }>;
};

type SeriesPoint = {
  value: number;
  end: Date;
  start?: Date;
  form?: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
};

type CompanyFactsError =
  | { code: "config_invalid"; message: string }
  | {
      code: "http_failure";
      message: string;
      errorCode:
        | "timeout"
        | "transport_error"
        | "non_success_status"
        | "invalid_json";
      httpStatus?: number;
      retryable: boolean;
      cause?: unknown;
    }
  | { code: "malformed_response"; message: string; cause?: unknown };

const allowedForms = new Set(["10-K", "10-Q", "20-F", "6-K"]);

const directMetricDefinitions: DirectMetricDefinition[] = [
  {
    metricName: "eps",
    confidence: 0.9,
    unitCandidates: ["USD/shares", "usd/shares"],
    tags: [
      { taxonomy: "us-gaap", tag: "EarningsPerShareDiluted" },
      { taxonomy: "us-gaap", tag: "EarningsPerShareBasic" },
    ],
  },
  {
    metricName: "shares_diluted",
    confidence: 0.88,
    unitCandidates: ["shares"],
    tags: [
      {
        taxonomy: "us-gaap",
        tag: "WeightedAverageNumberOfDilutedSharesOutstanding",
      },
    ],
  },
  {
    metricName: "shares_basic",
    confidence: 0.88,
    unitCandidates: ["shares"],
    tags: [
      {
        taxonomy: "us-gaap",
        tag: "WeightedAverageNumberOfSharesOutstandingBasic",
      },
    ],
  },
];

const sortByEndDesc = (left: SeriesPoint, right: SeriesPoint): number =>
  right.end.getTime() - left.end.getTime();

const toDate = (raw: string | undefined): Date | undefined => {
  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    return undefined;
  }

  return parsed;
};

/**
 * Adapts SEC companyfacts payloads into normalized KPI-centric metric points.
 */
export class SecCompanyFactsProvider implements CompanyFactsProviderPort {
  private readonly symbolToCik = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly tickersUrl: string,
    private readonly userAgent: string,
    private readonly timeoutMs = 15_000,
    private readonly maxFactsPerMetric = 16,
    private readonly httpClient = new HttpJsonClient(),
    private readonly providerRateLimiter: ProviderRateLimiterPort = noOpRateLimiter,
  ) {
    if (!this.userAgent.trim()) {
      throw new Error(
        "SEC_EDGAR_USER_AGENT is required when SEC companyfacts provider is enabled.",
      );
    }
  }

  /**
   * Fetches SEC companyfacts and converts selected XBRL facts to normalized metrics.
   */
  async fetchCompanyFacts(
    request: MetricsRequest,
  ): Promise<Result<MetricsFetchResult, AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();
    const diagnosticsBase = {
      provider: "sec-companyfacts",
      symbol,
    } as const;

    const cikResult = await this.resolveCik(symbol);
    if (cikResult.isErr()) {
      return err(this.mapToBoundaryError(cikResult.error, symbol));
    }

    if (!cikResult.value) {
      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: "empty",
          metricCount: 0,
          reason: "Ticker to CIK could not be resolved from SEC mapping.",
        },
      });
    }

    const companyFactsResult = await this.fetchCompanyFactsPayload(cikResult.value);
    if (companyFactsResult.isErr()) {
      return err(this.mapToBoundaryError(companyFactsResult.error, symbol));
    }

    const payload = companyFactsResult.value;
    if (!payload || typeof payload !== "object") {
      return ok({
        metrics: [],
        diagnostics: {
          ...diagnosticsBase,
          status: "malformed_response",
          metricCount: 0,
          reason: "Companyfacts payload was not an object.",
        },
      });
    }

    const metrics = this.mapMetrics(payload, symbol, asOf);
    return ok({
      metrics,
      diagnostics: {
        ...diagnosticsBase,
        status: metrics.length > 0 ? "ok" : "empty",
        metricCount: metrics.length,
        reason:
          metrics.length > 0
            ? undefined
            : "No mappable KPI-centric companyfacts were available.",
      },
    });
  }

  /**
   * Resolves and caches SEC CIKs so per-run companyfacts fetches stay bounded.
   */
  private async resolveCik(
    symbol: string,
  ): Promise<Result<string | null, CompanyFactsError>> {
    const cached = this.symbolToCik.get(symbol);
    if (cached) {
      return ok(cached);
    }

    const mappingResult = await this.fetchJson<EdgarTickersResponse>(
      this.tickersUrl,
      "application/json",
    );
    if (mappingResult.isErr()) {
      return err(mappingResult.error);
    }

    const mapping = mappingResult.value;
    if (!mapping || typeof mapping !== "object") {
      return err({
        code: "malformed_response",
        message: "SEC ticker mapping payload was malformed.",
      });
    }

    for (const record of Object.values(mapping)) {
      const ticker = record.ticker?.trim().toUpperCase();
      if (!ticker) {
        continue;
      }
      if (!Number.isInteger(record.cik_str)) {
        continue;
      }
      this.symbolToCik.set(ticker, String(record.cik_str).padStart(10, "0"));
    }

    return ok(this.symbolToCik.get(symbol) ?? null);
  }

  /**
   * Fetches SEC companyfacts payload for one CIK.
   */
  private async fetchCompanyFactsPayload(
    cik: string,
  ): Promise<Result<CompanyFactsResponse, CompanyFactsError>> {
    const url = new URL(`/api/xbrl/companyfacts/CIK${cik}.json`, this.baseUrl).toString();
    return this.fetchJson<CompanyFactsResponse>(url, "application/json");
  }

  /**
   * Converts selected SEC facts into direct and derived KPI metrics.
   */
  private mapMetrics(
    payload: CompanyFactsResponse,
    symbol: string,
    asOf: Date,
  ): NormalizedMarketMetricPoint[] {
    const metrics: NormalizedMarketMetricPoint[] = [];
    const latestByName = new Set<string>();
    const facts = payload.facts ?? {};

    const revenueSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "RevenueFromContractWithCustomerExcludingAssessedTax" },
        { taxonomy: "us-gaap", tag: "Revenues" }],
      ["USD", "usd"],
    );
    const grossProfitSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "GrossProfit" }],
      ["USD", "usd"],
    );
    const operatingIncomeSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "OperatingIncomeLoss" }],
      ["USD", "usd"],
    );
    const netIncomeSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "NetIncomeLoss" }],
      ["USD", "usd"],
    );
    const operatingCashFlowSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "NetCashProvidedByUsedInOperatingActivities" }],
      ["USD", "usd"],
    );
    const capexSeries = this.extractSeries(
      facts,
      [{ taxonomy: "us-gaap", tag: "PaymentsToAcquirePropertyPlantAndEquipment" }],
      ["USD", "usd"],
    );

    const addMetric = (
      metricName: string,
      value: number,
      periodType: NormalizedMarketMetricPoint["periodType"],
      metricUnit: string,
      confidence: number,
      rawPayload: unknown,
      pointAsOf?: Date,
    ) => {
      const rounded = Number(value.toFixed(metricUnit === "ratio" ? 6 : 4));
      if (!Number.isFinite(rounded)) {
        return;
      }
      const dedupeKey = `${metricName}|${pointAsOf?.toISOString() ?? asOf.toISOString()}`;
      if (latestByName.has(dedupeKey)) {
        return;
      }
      latestByName.add(dedupeKey);
      metrics.push({
        id: `sec-companyfacts-${symbol}-${metricName}-${(pointAsOf ?? asOf).toISOString()}`,
        provider: "sec-companyfacts",
        symbol,
        metricName,
        metricValue: rounded,
        metricUnit,
        currency: metricUnit === "shares" ? undefined : "USD",
        asOf: pointAsOf ?? asOf,
        periodType,
        confidence,
        rawPayload,
      });
    };

    const latestAnnualRevenue = this.pickLatestByPeriod(revenueSeries, "annual");
    if (latestAnnualRevenue) {
      addMetric(
        "revenue",
        latestAnnualRevenue.value,
        "annual",
        "usd",
        0.9,
        { source: "companyfacts", metric: "revenue_annual" },
        latestAnnualRevenue.end,
      );
    }

    const revenueTtm = this.sumLatestQuarterWindow(revenueSeries, 4);
    if (revenueTtm) {
      addMetric(
        "revenue_ttm",
        revenueTtm.value,
        "ttm",
        "usd",
        0.8,
        { source: "companyfacts", metric: "revenue_ttm" },
        revenueTtm.end,
      );
    }

    const revenueYoy = this.computeRevenueYoy(revenueSeries);
    if (revenueYoy) {
      addMetric(
        "revenue_yoy",
        revenueYoy.value,
        "quarter",
        "ratio",
        0.78,
        { source: "companyfacts", metric: "revenue_yoy" },
        revenueYoy.end,
      );
      addMetric(
        "revenue_growth_yoy",
        revenueYoy.value,
        "quarter",
        "ratio",
        0.78,
        { source: "companyfacts", metric: "revenue_growth_yoy" },
        revenueYoy.end,
      );
    }

    const latestQuarterRevenue = this.pickLatestByPeriod(revenueSeries, "quarter");
    if (latestQuarterRevenue) {
      const grossProfitPoint = this.findPointByEndDate(
        grossProfitSeries,
        latestQuarterRevenue.end,
      );
      if (grossProfitPoint && latestQuarterRevenue.value !== 0) {
        addMetric(
          "gross_margin",
          grossProfitPoint.value / latestQuarterRevenue.value,
          "quarter",
          "ratio",
          0.76,
          { source: "companyfacts", metric: "gross_margin" },
          latestQuarterRevenue.end,
        );
      }

      const operatingIncomePoint = this.findPointByEndDate(
        operatingIncomeSeries,
        latestQuarterRevenue.end,
      );
      if (operatingIncomePoint && latestQuarterRevenue.value !== 0) {
        addMetric(
          "operating_margin",
          operatingIncomePoint.value / latestQuarterRevenue.value,
          "quarter",
          "ratio",
          0.76,
          { source: "companyfacts", metric: "operating_margin" },
          latestQuarterRevenue.end,
        );
      }

      const netIncomePoint = this.findPointByEndDate(
        netIncomeSeries,
        latestQuarterRevenue.end,
      );
      if (netIncomePoint && latestQuarterRevenue.value !== 0) {
        addMetric(
          "profit_margin",
          netIncomePoint.value / latestQuarterRevenue.value,
          "quarter",
          "ratio",
          0.76,
          { source: "companyfacts", metric: "profit_margin" },
          latestQuarterRevenue.end,
        );
      }
    }

    const operatingCashFlowTtm = this.sumLatestQuarterWindow(operatingCashFlowSeries, 4);
    if (operatingCashFlowTtm) {
      addMetric(
        "operating_cash_flow_ttm",
        operatingCashFlowTtm.value,
        "ttm",
        "usd",
        0.8,
        { source: "companyfacts", metric: "operating_cash_flow_ttm" },
        operatingCashFlowTtm.end,
      );
    }

    const capexTtm = this.sumLatestQuarterWindow(capexSeries, 4);
    if (capexTtm) {
      addMetric(
        "capex_ttm",
        Math.abs(capexTtm.value),
        "ttm",
        "usd",
        0.75,
        { source: "companyfacts", metric: "capex_ttm" },
        capexTtm.end,
      );
    }

    directMetricDefinitions.forEach((definition) => {
      const series = this.extractSeries(facts, definition.tags, definition.unitCandidates);
      const latest = series.at(0);
      if (!latest) {
        return;
      }
      addMetric(
        definition.metricName,
        latest.value,
        this.toPeriodType(latest),
        definition.metricName.includes("shares") ? "shares" : "usd",
        definition.confidence,
        {
          source: "companyfacts",
          taxonomyTag: definition.tags.map((tag) => `${tag.taxonomy}:${tag.tag}`),
        },
        latest.end,
      );
    });

    const sharesSeries = this.extractSeries(
      facts,
      [
        {
          taxonomy: "us-gaap",
          tag: "WeightedAverageNumberOfDilutedSharesOutstanding",
        },
      ],
      ["shares"],
    );
    const sharesYoy = this.computeQuarterYoy(sharesSeries);
    if (sharesYoy) {
      addMetric(
        "shares_diluted_yoy_change",
        sharesYoy.value,
        "quarter",
        "ratio",
        0.72,
        { source: "companyfacts", metric: "shares_diluted_yoy_change" },
        sharesYoy.end,
      );
    }

    return metrics;
  }

  /**
   * Extracts and normalizes a bounded SEC fact series for selected taxonomy tags and units.
   */
  private extractSeries(
    facts: Record<string, Record<string, CompanyFactsTag>>,
    tags: Array<{ taxonomy: string; tag: string }>,
    unitCandidates: string[],
  ): SeriesPoint[] {
    for (const tag of tags) {
      const tagPayload = facts[tag.taxonomy]?.[tag.tag];
      const units = tagPayload?.units;
      if (!units) {
        continue;
      }

      for (const unitCandidate of unitCandidates) {
        const points = units[unitCandidate];
        if (!Array.isArray(points)) {
          continue;
        }

        const mapped = points
          .slice(0, this.maxFactsPerMetric)
          .map((point) => {
            const value =
              typeof point.val === "number" ? point.val : Number.NaN;
            const end = toDate(point.end);
            const start = toDate(point.start);
            if (!Number.isFinite(value) || !end) {
              return null;
            }
            return {
              value,
              end,
              start,
              form: point.form,
              fiscalYear: point.fy,
              fiscalPeriod: point.fp,
            } as SeriesPoint;
          })
          .filter((point): point is SeriesPoint => Boolean(point))
          .filter(
            (point) => !point.form || allowedForms.has(point.form.toUpperCase()),
          )
          .sort(sortByEndDesc);

        if (mapped.length > 0) {
          return mapped;
        }
      }
    }

    return [];
  }

  /**
   * Picks the latest point by desired annual/quarter cadence.
   */
  private pickLatestByPeriod(
    points: SeriesPoint[],
    cadence: "annual" | "quarter",
  ): SeriesPoint | null {
    return (
      points.find((point) =>
        cadence === "annual"
          ? this.toPeriodType(point) === "annual"
          : this.toPeriodType(point) === "quarter",
      ) ?? null
    );
  }

  /**
   * Sums the latest quarterly window for derived TTM metrics.
   */
  private sumLatestQuarterWindow(
    points: SeriesPoint[],
    windowSize: number,
  ): { value: number; end: Date } | null {
    const quarters = points
      .filter((point) => this.toPeriodType(point) === "quarter")
      .slice(0, windowSize);
    if (quarters.length < windowSize) {
      return null;
    }

    return {
      value: quarters.reduce((sum, point) => sum + point.value, 0),
      end: quarters[0]?.end ?? new Date(),
    };
  }

  /**
   * Computes year-over-year growth from quarterly or annual revenue points.
   */
  private computeRevenueYoy(
    points: SeriesPoint[],
  ): { value: number; end: Date } | null {
    const quarterly = points.filter(
      (point) => this.toPeriodType(point) === "quarter",
    );
    if (quarterly.length >= 5) {
      const latest = quarterly[0];
      const baseline = quarterly[4];
      if (!latest || !baseline || baseline.value === 0) {
        return null;
      }
      return { value: latest.value / baseline.value - 1, end: latest.end };
    }

    const annual = points.filter((point) => this.toPeriodType(point) === "annual");
    if (annual.length >= 2) {
      const latest = annual[0];
      const baseline = annual[1];
      if (!latest || !baseline || baseline.value === 0) {
        return null;
      }
      return { value: latest.value / baseline.value - 1, end: latest.end };
    }

    return null;
  }

  /**
   * Computes quarterly year-over-year change for share-count trend proxy.
   */
  private computeQuarterYoy(
    points: SeriesPoint[],
  ): { value: number; end: Date } | null {
    const quarterly = points.filter(
      (point) => this.toPeriodType(point) === "quarter",
    );
    if (quarterly.length < 5) {
      return null;
    }
    const latest = quarterly[0];
    const baseline = quarterly[4];
    if (!latest || !baseline || baseline.value === 0) {
      return null;
    }
    return { value: latest.value / baseline.value - 1, end: latest.end };
  }

  /**
   * Aligns numerator/denominator pairs by end date to derive margin ratios deterministically.
   */
  private findPointByEndDate(
    points: SeriesPoint[],
    targetEnd: Date,
  ): SeriesPoint | null {
    const hit =
      points.find(
        (point) =>
          point.end.toISOString().slice(0, 10) ===
          targetEnd.toISOString().slice(0, 10),
      ) ?? null;
    return hit;
  }

  /**
   * Infers period type from SEC point metadata.
   */
  private toPeriodType(
    point: SeriesPoint,
  ): NormalizedMarketMetricPoint["periodType"] {
    const fp = point.fiscalPeriod?.toUpperCase();
    if (fp === "FY") {
      return "annual";
    }
    if (fp && /^Q[1-4]$/.test(fp)) {
      return "quarter";
    }
    if (!point.start) {
      return "point_in_time";
    }
    const days = (point.end.getTime() - point.start.getTime()) / (1000 * 60 * 60 * 24);
    if (days >= 320) {
      return "annual";
    }
    if (days >= 70 && days <= 120) {
      return "quarter";
    }
    return "point_in_time";
  }

  /**
   * Executes one SEC JSON request with consistent headers/retries and normalized failures.
   */
  private async fetchJson<T>(
    url: string,
    acceptHeader: string,
  ): Promise<Result<T, CompanyFactsError>> {
    const response = await this.httpClient.requestJson<T>({
      url,
      method: "GET",
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 300,
      beforeAttempt: async () => {
        await this.providerRateLimiter.waitForSlot("sec-edgar");
      },
      headers: {
        "User-Agent": this.userAgent,
        Accept: acceptHeader,
      },
    });

    if (response.isErr()) {
      return err({
        code: "http_failure",
        message: response.error.message,
        errorCode: response.error.code,
        httpStatus: response.error.httpStatus,
        retryable: response.error.retryable,
        cause: response.error.cause,
      });
    }

    return ok(response.value);
  }

  /**
   * Maps adapter failures to boundary errors for ingestion-level degrade handling.
   */
  private mapToBoundaryError(
    failure: CompanyFactsError,
    symbol: string,
  ): AppBoundaryError {
    if (failure.code === "config_invalid") {
      return {
        source: "metrics",
        code: "config_invalid",
        provider: "sec-companyfacts",
        message: failure.message,
        retryable: false,
        cause: { symbol },
      };
    }

    if (failure.code === "malformed_response") {
      return {
        source: "metrics",
        code: "malformed_response",
        provider: "sec-companyfacts",
        message: failure.message,
        retryable: false,
        cause: failure.cause,
      };
    }

    const mappedCode: AppBoundaryError["code"] =
      failure.errorCode === "invalid_json"
        ? "invalid_json"
        : failure.errorCode === "timeout"
          ? "timeout"
          : failure.httpStatus === 429
            ? "rate_limited"
            : failure.httpStatus === 401 || failure.httpStatus === 403
              ? "auth_invalid"
              : failure.errorCode === "transport_error"
                ? "transport_error"
                : "provider_error";

    return {
      source: "metrics",
      code: mappedCode,
      provider: "sec-companyfacts",
      message: failure.message,
      retryable: failure.retryable,
      httpStatus: failure.httpStatus,
      cause: failure.cause,
    };
  }
}


import { err, ok, type Result } from "neverthrow";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type {
  AnalystTrendSignal,
  EarningsGuidanceSignal,
  MarketContextFetchResult,
  MarketContextProviderPort,
  MarketContextRequest,
  PriceContextSignal,
  PeerRelativeValuationSignal,
} from "../../../core/ports/inboundPorts";
import type { ProviderRateLimiterPort } from "../../../core/ports/outboundPorts";
import { HttpJsonClient } from "../../http/httpJsonClient";

const noOpRateLimiter: ProviderRateLimiterPort = {
  waitForSlot: async () => {},
  tryConsumeDailyBudget: async () => ({ allowed: true }),
};

type FinnhubRecommendationRow = {
  period?: string;
  buy?: number;
  hold?: number;
  sell?: number;
  strongBuy?: number;
  strongSell?: number;
};

type FinnhubMetricPayload = {
  metric?: {
    peBasicExclExtraTTM?: number;
    peTTM?: number;
    revenueGrowthTTMYoy?: number;
  };
};

type FinnhubEarningsCalendarPayload = {
  earningsCalendar?: Array<{
    date?: string;
    epsActual?: number;
    epsEstimate?: number;
  }>;
};

type FinnhubCandlesPayload = {
  c?: number[];
  t?: number[];
  s?: string;
};

/**
 * Builds deterministic market-context signals from Finnhub endpoints so ingestion can enrich thesis evidence without LLM inference.
 */
export class FinnhubMarketContextProvider implements MarketContextProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
    private readonly httpClient = new HttpJsonClient(),
    private readonly providerRateLimiter: ProviderRateLimiterPort = noOpRateLimiter,
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "FINNHUB_API_KEY is required when Finnhub market context provider is enabled.",
      );
    }
  }

  /**
   * Fetches peer-relative, earnings, and analyst trend context while degrading to empty signals when providers are unavailable.
   */
  async fetchMarketContext(
    request: MarketContextRequest,
  ): Promise<Result<MarketContextFetchResult, AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const asOf = request.asOf ?? new Date();

    const peersResult = await this.fetchPeers(symbol);
    if (peersResult.isErr()) {
      return err(peersResult.error);
    }

    const peerSymbols = peersResult.value.slice(0, 10);
    const peerMetricSignals = await this.buildPeerSignals(symbol, peerSymbols, asOf);
    if (peerMetricSignals.isErr()) {
      return err(peerMetricSignals.error);
    }

    const [earningsSignals, analystSignals, priceContextSignalsResult] = await Promise.all([
      this.buildEarningsSignals(symbol, asOf),
      this.buildAnalystSignals(symbol, asOf),
      this.buildPriceContextSignals(symbol, asOf),
    ]);

    if (earningsSignals.isErr()) {
      return err(earningsSignals.error);
    }

    if (analystSignals.isErr()) {
      return err(analystSignals.error);
    }

    // Treat price-context as optional enrichment because some Finnhub plans
    // don't allow candle access for all symbols/endpoints.
    const priceContextSignals = priceContextSignalsResult.isOk()
      ? priceContextSignalsResult.value
      : [];
    const priceContextWarning =
      priceContextSignalsResult.isErr()
        ? `price_context_unavailable:${priceContextSignalsResult.error.code}${typeof priceContextSignalsResult.error.httpStatus === "number" ? `:${priceContextSignalsResult.error.httpStatus}` : ""}`
        : undefined;

    const value: MarketContextFetchResult = {
      peerRelativeValuation: peerMetricSignals.value,
      earningsGuidance: earningsSignals.value,
      analystTrend: analystSignals.value,
      priceContext: priceContextSignals,
      diagnostics: {
        provider: "finnhub-market-context",
        symbol,
        status:
          peerMetricSignals.value.length +
            earningsSignals.value.length +
            analystSignals.value.length +
            priceContextSignals.length >
          0
            ? "ok"
            : "empty",
        itemCounts: {
          peerRelativeValuation: peerMetricSignals.value.length,
          earningsGuidance: earningsSignals.value.length,
          analystTrend: analystSignals.value.length,
          priceContext: priceContextSignals.length,
        },
        reason: priceContextWarning,
      },
    };

    return ok(value);
  }

  /**
   * Fetches peer symbols so relative valuation and growth percentile signals can be computed deterministically.
   */
  private async fetchPeers(symbol: string): Promise<Result<string[], AppBoundaryError>> {
    const url = new URL("/api/v1/stock/peers", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", this.apiKey);
    const payloadResult = await this.requestJson<unknown>(url.toString());
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const payload = payloadResult.value;
    if (!Array.isArray(payload)) {
      return ok([]);
    }

    return ok(
      payload
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item.length > 0 && item !== symbol),
    );
  }

  /**
   * Builds peer-relative valuation metrics from target/peer fundamentals with bounded sampling for latency control.
   */
  private async buildPeerSignals(
    symbol: string,
    peerSymbols: string[],
    asOf: Date,
  ): Promise<Result<PeerRelativeValuationSignal[], AppBoundaryError>> {
    const symbols = [symbol, ...peerSymbols].slice(0, 6);
    const payloads = await Promise.all(
      symbols.map(async (ticker) => this.fetchBasicMetricPayload(ticker)),
    );

    const failed = payloads.find((result) => result.isErr());
    if (failed?.isErr()) {
      return err(failed.error);
    }

    const metricBySymbol = new Map<string, FinnhubMetricPayload["metric"]>();
    payloads.forEach((result, index) => {
      if (result.isOk()) {
        metricBySymbol.set(symbols[index] as string, result.value.metric ?? {});
      }
    });

    const target = metricBySymbol.get(symbol) ?? {};
    const targetPe =
      typeof target.peBasicExclExtraTTM === "number"
        ? target.peBasicExclExtraTTM
        : target.peTTM;
    const targetGrowth =
      typeof target.revenueGrowthTTMYoy === "number"
        ? target.revenueGrowthTTMYoy
        : undefined;

    const peerPeValues = peerSymbols
      .slice(0, 5)
      .map((peer) => metricBySymbol.get(peer))
      .map((metric) =>
        typeof metric?.peBasicExclExtraTTM === "number"
          ? metric.peBasicExclExtraTTM
          : metric?.peTTM,
      )
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const peerGrowthValues = peerSymbols
      .slice(0, 5)
      .map((peer) => metricBySymbol.get(peer)?.revenueGrowthTTMYoy)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    const signals: PeerRelativeValuationSignal[] = [];

    if (typeof targetPe === "number" && peerPeValues.length > 0) {
      const pePercentile = this.computePercentile(targetPe, peerPeValues);
      const peerPeMedian = this.computeMedian(peerPeValues);
      const pePremiumPct =
        peerPeMedian === 0 ? 0 : ((targetPe - peerPeMedian) / peerPeMedian) * 100;

      signals.push({
        metricName: "peer_pe_percentile",
        metricValue: pePercentile,
        metricUnit: "pct",
        asOf,
        confidence: 0.75,
        rawPayload: { symbol, targetPe, peerPeValues },
      });
      signals.push({
        metricName: "peer_pe_premium_pct",
        metricValue: pePremiumPct,
        metricUnit: "pct",
        asOf,
        confidence: 0.75,
        rawPayload: { symbol, targetPe, peerPeMedian },
      });
    }

    if (typeof targetGrowth === "number" && peerGrowthValues.length > 0) {
      signals.push({
        metricName: "peer_rev_growth_percentile",
        metricValue: this.computePercentile(targetGrowth, peerGrowthValues),
        metricUnit: "pct",
        asOf,
        confidence: 0.7,
        rawPayload: { symbol, targetGrowth, peerGrowthValues },
      });
    }

    return ok(signals);
  }

  /**
   * Builds earnings-event signals from Finnhub earnings calendar payloads.
   */
  private async buildEarningsSignals(
    symbol: string,
    asOf: Date,
  ): Promise<Result<EarningsGuidanceSignal[], AppBoundaryError>> {
    const url = new URL("/api/v1/calendar/earnings", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", this.apiKey);
    const payloadResult = await this.requestJson<FinnhubEarningsCalendarPayload>(
      url.toString(),
    );
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const rows = payloadResult.value?.earningsCalendar ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return ok([]);
    }

    const sorted = rows
      .map((row) => ({
        row,
        date: row.date ? new Date(row.date) : null,
      }))
      .filter((item) => item.date && Number.isFinite(item.date.getTime()))
      .sort((left, right) => (left.date as Date).getTime() - (right.date as Date).getTime());

    const nextEvent = sorted.find((item) => (item.date as Date).getTime() >= asOf.getTime());
    const latestWithEps = [...sorted]
      .reverse()
      .find(
        (item) =>
          typeof item.row.epsActual === "number" &&
          typeof item.row.epsEstimate === "number" &&
          item.row.epsEstimate !== 0,
      );

    const signals: EarningsGuidanceSignal[] = [];

    if (latestWithEps) {
      const epsActual = latestWithEps.row.epsActual as number;
      const epsEstimate = latestWithEps.row.epsEstimate as number;
      const surprisePct = ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100;
      signals.push({
        metricName: "earnings_surprise_pct_last",
        metricValue: surprisePct,
        metricUnit: "pct",
        asOf: latestWithEps.date as Date,
        confidence: 0.8,
        rawPayload: latestWithEps.row,
      });
    }

    if (nextEvent) {
      const daysToNext = Math.ceil(
        ((nextEvent.date as Date).getTime() - asOf.getTime()) / (24 * 60 * 60 * 1000),
      );
      signals.push({
        metricName: "earnings_event_days_to_next",
        metricValue: Math.max(0, daysToNext),
        metricUnit: "days",
        asOf,
        confidence: 0.85,
        rawPayload: nextEvent.row,
      });
    }

    return ok(signals);
  }

  /**
   * Builds analyst recommendation trend signals over recent windows for deterministic directionality context.
   */
  private async buildAnalystSignals(
    symbol: string,
    asOf: Date,
  ): Promise<Result<AnalystTrendSignal[], AppBoundaryError>> {
    const url = new URL("/api/v1/stock/recommendation", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", this.apiKey);
    const payloadResult = await this.requestJson<unknown>(url.toString());
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    if (!Array.isArray(payloadResult.value)) {
      return ok([]);
    }

    const rows = payloadResult.value as FinnhubRecommendationRow[];
    const normalized = rows
      .map((row) => ({
        ...row,
        periodDate: row.period ? new Date(`${row.period}T00:00:00.000Z`) : null,
      }))
      .filter((row) => row.periodDate && Number.isFinite(row.periodDate.getTime()))
      .sort((left, right) => right.periodDate!.getTime() - left.periodDate!.getTime());

    const latest = normalized.at(0);
    const prior = normalized.at(1);
    if (!latest) {
      return ok([]);
    }

    const latestTotals = this.recommendationTotals(latest);
    if (latestTotals.total === 0) {
      return ok([]);
    }

    const analystBuyRatio = latestTotals.buy / latestTotals.total;
    const analystConsensusScore =
      (latestTotals.strongBuy * 1 +
        latestTotals.buy * 0.75 +
        latestTotals.hold * 0.5 +
        latestTotals.sell * 0.25 +
        latestTotals.strongSell * 0) /
      latestTotals.total;
    const priorTotals = prior ? this.recommendationTotals(prior) : null;
    const priorBuyRatio =
      priorTotals && priorTotals.total > 0 ? priorTotals.buy / priorTotals.total : analystBuyRatio;

    return ok([
      {
        metricName: "analyst_buy_ratio",
        metricValue: analystBuyRatio,
        metricUnit: "ratio",
        asOf,
        confidence: 0.8,
        rawPayload: latest,
      },
      {
        metricName: "analyst_buy_ratio_delta_30d",
        metricValue: analystBuyRatio - priorBuyRatio,
        metricUnit: "ratio_delta",
        asOf,
        confidence: 0.75,
        rawPayload: { latest, prior },
      },
      {
        metricName: "analyst_consensus_score",
        metricValue: analystConsensusScore,
        metricUnit: "score_0_1",
        asOf,
        confidence: 0.75,
        rawPayload: latest,
      },
    ]);
  }

  /**
   * Builds price-context signals from daily candles so synthesis can anchor actions to deterministic momentum and volatility regimes.
   */
  private async buildPriceContextSignals(
    symbol: string,
    asOf: Date,
  ): Promise<Result<PriceContextSignal[], AppBoundaryError>> {
    const to = Math.floor(asOf.getTime() / 1000);
    const from = Math.floor(
      new Date(asOf.getTime() - 220 * 24 * 60 * 60 * 1000).getTime() / 1000,
    );
    const url = new URL("/api/v1/stock/candle", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("resolution", "D");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("token", this.apiKey);

    const payloadResult = await this.requestJson<FinnhubCandlesPayload>(
      url.toString(),
    );
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const closes = payloadResult.value.c ?? [];
    const status = payloadResult.value.s ?? "";
    if (status.toLowerCase() !== "ok" || !Array.isArray(closes) || closes.length < 30) {
      return ok([]);
    }

    const numericCloses = closes.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (numericCloses.length < 30) {
      return ok([]);
    }

    const latestClose = numericCloses[numericCloses.length - 1];
    const close3m = numericCloses[Math.max(0, numericCloses.length - 63)];
    const close6m = numericCloses[Math.max(0, numericCloses.length - 126)];
    const returns20d = this.computeDailyReturns(numericCloses.slice(-21));
    const volatilityRegimeScore = this.computeVolatilityRegimeScore(returns20d);

    const signals: PriceContextSignal[] = [];
    if (typeof latestClose === "number" && typeof close3m === "number" && close3m !== 0) {
      signals.push({
        metricName: "price_return_3m",
        metricValue: ((latestClose - close3m) / close3m) * 100,
        metricUnit: "pct",
        asOf,
        confidence: 0.8,
        rawPayload: { latestClose, close3m },
      });
    }

    if (typeof latestClose === "number" && typeof close6m === "number" && close6m !== 0) {
      signals.push({
        metricName: "price_return_6m",
        metricValue: ((latestClose - close6m) / close6m) * 100,
        metricUnit: "pct",
        asOf,
        confidence: 0.78,
        rawPayload: { latestClose, close6m },
      });
    }

    signals.push({
      metricName: "volatility_regime_score",
      metricValue: volatilityRegimeScore,
      metricUnit: "score_0_100",
      asOf,
      confidence: 0.75,
      rawPayload: { returns20dCount: returns20d.length },
    });

    return ok(signals);
  }

  /**
   * Fetches one symbol metric payload from Finnhub `/stock/metric` and maps transport faults to boundary errors.
   */
  private async fetchBasicMetricPayload(
    symbol: string,
  ): Promise<Result<FinnhubMetricPayload, AppBoundaryError>> {
    const url = new URL("/api/v1/stock/metric", this.baseUrl);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("metric", "all");
    url.searchParams.set("token", this.apiKey);
    return this.requestJson<FinnhubMetricPayload>(url.toString());
  }

  /**
   * Executes a Finnhub JSON request under provider pacing and returns contract-stable boundary failures.
   */
  private async requestJson<T>(
    url: string,
  ): Promise<Result<T, AppBoundaryError>> {
    const response = await this.httpClient.requestJson<T>({
      url,
      method: "GET",
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 250,
      beforeAttempt: async () => {
        await this.providerRateLimiter.waitForSlot("finnhub");
      },
    });

    if (response.isErr()) {
      return err({
        source: "metrics",
        code: this.mapHttpCode(
          response.error.httpStatus,
          response.error.message,
          response.error.code,
        ),
        provider: "finnhub-market-context",
        message: response.error.message,
        retryable: response.error.retryable,
        httpStatus: response.error.httpStatus,
        cause: response.error.cause,
      });
    }

    return ok(response.value);
  }

  private recommendationTotals(row: FinnhubRecommendationRow) {
    const strongBuy = row.strongBuy ?? 0;
    const buy = row.buy ?? 0;
    const hold = row.hold ?? 0;
    const sell = row.sell ?? 0;
    const strongSell = row.strongSell ?? 0;
    return {
      strongBuy,
      buy,
      hold,
      sell,
      strongSell,
      total: strongBuy + buy + hold + sell + strongSell,
    };
  }

  private computeMedian(values: number[]): number {
    const sorted = values.slice().sort((left, right) => left - right);
    if (sorted.length === 0) {
      return 0;
    }
    const midpoint = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
    }
    return sorted[midpoint]!;
  }

  private computePercentile(target: number, peers: number[]): number {
    if (peers.length === 0) {
      return 50;
    }

    const lessOrEqual = peers.filter((value) => value <= target).length;
    return (lessOrEqual / peers.length) * 100;
  }

  private computeDailyReturns(closes: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const previous = closes[i - 1];
      const current = closes[i];
      if (
        typeof previous === "number" &&
        typeof current === "number" &&
        Number.isFinite(previous) &&
        Number.isFinite(current) &&
        previous !== 0
      ) {
        returns.push((current - previous) / previous);
      }
    }
    return returns;
  }

  private computeVolatilityRegimeScore(returns: number[]): number {
    if (returns.length === 0) {
      return 0;
    }

    const mean =
      returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      returns.length;
    const dailyVolPct = Math.sqrt(Math.max(variance, 0)) * 100;
    return Math.max(0, Math.min(100, Number((dailyVolPct * 8).toFixed(2))));
  }

  private mapHttpCode(
    httpStatus: number | undefined,
    message: string,
    errorCode:
      | "timeout"
      | "transport_error"
      | "non_success_status"
      | "invalid_json",
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }

    if (errorCode === "invalid_json") {
      return "invalid_json";
    }

    if (errorCode === "timeout") {
      return "timeout";
    }

    if (/timed out/i.test(message)) {
      return "timeout";
    }

    return "provider_error";
  }
}


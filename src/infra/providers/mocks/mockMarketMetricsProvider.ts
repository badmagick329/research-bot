import type {
  MarketMetricsProviderPort,
  MetricsRequest,
  NormalizedMarketMetricPoint,
} from "../../../core/ports/inboundPorts";

/**
 * Provides predictable numeric signals so synthesis behavior can be validated before real provider onboarding.
 */
export class MockMarketMetricsProvider implements MarketMetricsProviderPort {
  /**
   * Emits representative metric points to exercise repository upsert and scoring pathways.
   */
  async fetchMetrics(
    request: MetricsRequest,
  ): Promise<NormalizedMarketMetricPoint[]> {
    const asOf = request.asOf ?? new Date();
    const symbol = request.symbol.toUpperCase();

    return [
      {
        id: `${symbol}-metric-revenue-growth`,
        provider: "mock-fundamentals",
        symbol,
        metricName: "revenue_growth_yoy",
        metricValue: 0.14,
        metricUnit: "ratio",
        currency: "USD",
        asOf,
        periodType: "ttm",
        confidence: 0.92,
        rawPayload: { field: "revenueGrowthTTM", value: 0.14 },
      },
      {
        id: `${symbol}-metric-gross-margin`,
        provider: "mock-fundamentals",
        symbol,
        metricName: "gross_margin",
        metricValue: 0.58,
        metricUnit: "ratio",
        currency: "USD",
        asOf,
        periodType: "quarter",
        confidence: 0.9,
        rawPayload: { field: "grossMargin", value: 0.58 },
      },
      {
        id: `${symbol}-metric-ev-ebitda`,
        provider: "mock-fundamentals",
        symbol,
        metricName: "ev_to_ebitda",
        metricValue: 17.4,
        metricUnit: "multiple",
        currency: "USD",
        asOf,
        periodType: "point_in_time",
        confidence: 0.87,
        rawPayload: { field: "evToEbitda", value: 17.4 },
      },
    ];
  }
}

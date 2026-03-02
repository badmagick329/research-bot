import type { MetricPointEntity } from "../../../core/entities/metric";
import type {
  NormalizedSignal,
  SignalPack,
} from "../../../core/entities/research";
import type { SynthesisNormalizedSignalPort } from "./types";

/**
 * Normalizes raw metric points into comparable deterministic signals so decision scoring relies on hard numbers.
 */
export class DeterministicNormalizedSignalService
  implements SynthesisNormalizedSignalPort
{
  constructor(private readonly staleDaysThreshold: number = 60) {}

  /**
   * Builds a signal pack with trend and history-relative context to reduce binary gate dependence.
   */
  buildSignalPack(args: {
    metrics: MetricPointEntity[];
    now: Date;
    selectedKpiNames: string[];
  }): SignalPack {
    const byMetricName = new Map<string, MetricPointEntity[]>();
    args.metrics.forEach((metric) => {
      const existing = byMetricName.get(metric.metricName) ?? [];
      existing.push(metric);
      byMetricName.set(metric.metricName, existing);
    });

    const namesToScore = new Set<string>([
      ...args.selectedKpiNames,
      "price_to_earnings",
      "peer_pe_premium_pct",
      "revenue_growth_yoy",
      "profit_margin",
      "analyst_buy_ratio",
      "price_return_3m",
      "volatility_regime_score",
    ]);

    const signals: NormalizedSignal[] = [];
    namesToScore.forEach((metricName) => {
      const points = (byMetricName.get(metricName) ?? [])
        .slice()
        .sort((left, right) => right.asOf.getTime() - left.asOf.getTime());
      const latest = points[0];
      if (!latest) {
        return;
      }

      const previous = points[1];
      const prior = points[2];
      const level = this.toDirectionalLevel(metricName, latest.metricValue);
      const trend = previous
        ? this.clamp((latest.metricValue - previous.metricValue) / this.safeDenom(previous.metricValue), -1, 1)
        : 0;
      const priorTrend =
        previous && prior
          ? this.clamp((previous.metricValue - prior.metricValue) / this.safeDenom(prior.metricValue), -1, 1)
          : 0;
      const acceleration = this.clamp(trend - priorTrend, -1, 1);
      const freshnessDays = Math.max(
        0,
        Math.floor((args.now.getTime() - latest.asOf.getTime()) / (24 * 60 * 60 * 1000)),
      );
      const freshnessPenalty = this.clamp(freshnessDays / 120, 0, 1);
      const historyStats = this.computeHistoryStats(points.map((point) => point.metricValue));
      const historyZScore =
        historyStats.stdDev > 0
          ? (latest.metricValue - historyStats.mean) / historyStats.stdDev
          : 0;
      const peerZScore = metricName.includes("peer_")
        ? this.clamp(latest.metricValue / 20, -3, 3)
        : undefined;
      const normalizedValue = this.clamp(
        level * 0.5 + trend * 0.3 + acceleration * 0.2 - freshnessPenalty * 0.25,
        -1,
        1,
      );
      const confidenceContribution = this.clamp(
        0.45 +
          Math.min(0.25, points.length * 0.05) -
          Math.min(0.2, freshnessPenalty * 0.3),
        0,
        1,
      );

      signals.push({
        signalId: this.toSignalId(metricName),
        metricName,
        sourceMetricNames: [metricName],
        normalizedValue,
        direction:
          normalizedValue > 0.08
            ? "positive"
            : normalizedValue < -0.08
              ? "negative"
              : "neutral",
        level,
        trend,
        acceleration,
        freshnessDays,
        historyZScore: this.clamp(historyZScore, -3, 3),
        peerZScore,
        confidenceContribution,
      });
    });

    const freshSignals = signals.filter(
      (signal) => signal.freshnessDays <= this.staleDaysThreshold,
    ).length;
    return {
      signals: signals.sort((left, right) =>
        Math.abs(right.normalizedValue) - Math.abs(left.normalizedValue),
      ),
      coverage: {
        totalSignals: signals.length,
        freshSignals,
        staleSignals: Math.max(0, signals.length - freshSignals),
        hasPeerRelativeContext: signals.some(
          (signal) => typeof signal.peerZScore === "number",
        ),
      },
    };
  }

  /**
   * Applies metric semantics so positive/negative direction is stable across valuation and growth families.
   */
  private toDirectionalLevel(metricName: string, value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    const lowerIsBetterPatterns = [
      /price_to_earnings/,
      /price_to_book/,
      /ev_to_sales/,
      /ev_to_ebit/,
      /peer_pe_premium/,
      /volatility/,
      /days_to_next/,
    ];
    if (lowerIsBetterPatterns.some((pattern) => pattern.test(metricName))) {
      return this.clamp((1 - value / this.safeDenom(Math.max(1, value))) * 0.2, -1, 1);
    }

    if (/margin|growth|return|buy_ratio|guidance|demand_strength/.test(metricName)) {
      return this.clamp(value, -1, 1);
    }

    return this.clamp(value / this.safeDenom(Math.abs(value)), -1, 1);
  }

  /**
   * Avoids division spikes on near-zero baselines so trend and acceleration remain monotonic.
   */
  private safeDenom(value: number): number {
    return Math.max(0.0001, Math.abs(value));
  }

  /**
   * Computes history mean/stddev so latest values can be transformed into deterministic relative context.
   */
  private computeHistoryStats(values: number[]): { mean: number; stdDev: number } {
    if (values.length === 0) {
      return { mean: 0, stdDev: 0 };
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return { mean, stdDev: Math.sqrt(variance) };
  }

  /**
   * Keeps numeric outputs bounded so scoring remains comparable across metrics and sectors.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.parseFloat(value.toFixed(4))));
  }

  /**
   * Produces stable signal identifiers so diagnostics and tests can diff score attribution over time.
   */
  private toSignalId(metricName: string): string {
    return `signal_${metricName.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  }
}

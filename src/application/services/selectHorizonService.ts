import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { HorizonBucket, HorizonContext } from "../../core/entities/research";
import type {
  FilingsRepositoryPort,
  JobPayload,
  MetricsRepositoryPort,
  QueuePort,
} from "../../core/ports/outboundPorts";

/**
 * Selects thesis horizon deterministically so investor-facing decisions are aligned to event timing and evidence freshness.
 */
export class SelectHorizonService {
  constructor(
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly filingsRepo: FilingsRepositoryPort,
    private readonly queue: QueuePort,
  ) {}

  /**
   * Chooses a horizon bucket before KPI shaping so downstream sections can prioritize timeframe-relevant evidence.
   */
  async run(payload: JobPayload): Promise<void> {
    const [metrics, filings] = await Promise.all([
      this.metricsRepo.listBySymbol(payload.symbol, 30, payload.runId),
      this.filingsRepo.listBySymbol(payload.symbol, 10, payload.runId),
    ]);
    const context = this.select(payload, metrics, filings);
    await this.queue.enqueue("build_kpi_tree", {
      ...payload,
      horizonContext: context,
    });
  }

  /**
   * Maps observable checkpoint timing into one explicit horizon so horizon selection does not silently reclassify stock type.
   */
  private select(
    payload: JobPayload,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): HorizonContext {
    const metricByName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const eventDaysToNext = metricByName.get("earnings_event_days_to_next")?.metricValue;
    const now = Date.now();
    const latestFilingAgeDays = filings[0]
      ? Math.max(0, (now - filings[0].filedAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const type = payload.thesisTypeContext?.thesisType ?? "unclear";

    const fromEvent = typeof eventDaysToNext === "number" && eventDaysToNext >= 0 && eventDaysToNext <= 35;
    if (fromEvent) {
      return this.build(
        "0_4_weeks",
        "Near-term event timing dominates the next investable checkpoint window.",
        78,
      );
    }

    if (
      type === "compounder" ||
      type === "capital_return" ||
      type === "asset_play" ||
      type === "special_situation"
    ) {
      return this.build(
        "1_3_years",
        "Durability of business drivers is best judged across multiple reporting cycles.",
        70,
      );
    }

    if (latestFilingAgeDays !== null && latestFilingAgeDays <= 120) {
      return this.build(
        "1_2_quarters",
        "The next two earnings cycles are the clearest test for operating execution.",
        66,
      );
    }

    return this.build(
      "1_2_quarters",
      "Evidence quality is mixed; defaulting to intermediate horizon to reduce timing overconfidence.",
      52,
    );
  }

  /**
   * Normalizes horizon context construction to keep payload shape stable across rule paths.
   */
  private build(horizon: HorizonBucket, rationale: string, score: number): HorizonContext {
    return {
      horizon,
      rationale,
      score,
    };
  }
}


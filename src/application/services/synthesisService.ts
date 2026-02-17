import type {
  JobPayload,
  DocumentRepositoryPort,
  MetricsRepositoryPort,
  FilingsRepositoryPort,
  LlmPort,
  SnapshotRepositoryPort,
  ClockPort,
  IdGeneratorPort,
} from "../../core/ports/outboundPorts";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { FilingEntity } from "../../core/entities/filing";

/**
 * Consolidates evidence into a durable snapshot so decision outputs remain traceable to stored sources.
 */
export class SynthesisService {
  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly filingsRepo: FilingsRepositoryPort,
    private readonly snapshotRepo: SnapshotRepositoryPort,
    private readonly llm: LlmPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  /**
   * Treats mock providers as fallback-only evidence so historical mock rows don't pollute real runs.
   */
  private isMockProvider(provider: string): boolean {
    return provider.trim().toLowerCase().startsWith("mock");
  }

  /**
   * Keeps mock evidence only when no real provider evidence exists for the same evidence type.
   */
  private preferRealProviders<T extends { provider: string }>(items: T[]): T[] {
    if (items.length === 0) {
      return items;
    }

    const hasReal = items.some((item) => !this.isMockProvider(item.provider));
    if (!hasReal) {
      return items;
    }

    return items.filter((item) => !this.isMockProvider(item.provider));
  }

  /**
   * Removes repeated source references so snapshot citations stay concise and easier to audit.
   */
  private uniqueSources(
    docs: Awaited<ReturnType<DocumentRepositoryPort["listBySymbol"]>>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ) {
    const seen = new Set<string>();

    const documentSources = docs
      .map((doc) => ({
        provider: doc.provider,
        url: doc.url,
        title: doc.title,
      }))
      .filter((source) => {
        const key = `${source.provider}|${source.url ?? ""}|${source.title}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    const metricSources = metrics
      .map((metric) => ({
        provider: metric.provider,
        title: `metric:${metric.metricName} asOf:${metric.asOf.toISOString()}`,
      }))
      .filter((source) => {
        const key = `${source.provider}|${source.title}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    const filingSources = filings
      .map((filing) => ({
        provider: filing.provider,
        url: filing.docUrl,
        title: `${filing.filingType} ${filing.accessionNo ?? ""}`.trim(),
      }))
      .filter((source) => {
        const key = `${source.provider}|${source.url ?? ""}|${source.title}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    return [...documentSources, ...metricSources, ...filingSources];
  }

  /**
   * Stabilizes numeric display so LLM receives compact evidence without locale-dependent formatting drift.
   */
  private formatMetricValue(metric: MetricPointEntity): string {
    const value = metric.metricValue;

    if (!Number.isFinite(value)) {
      return "n/a";
    }

    if (Math.abs(value) >= 1_000_000_000) {
      return `${(value / 1_000_000_000).toFixed(2)}B`;
    }

    if (Math.abs(value) >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }

    if (Math.abs(value) >= 1_000) {
      return `${(value / 1_000).toFixed(2)}K`;
    }

    if (Math.abs(value) >= 1) {
      return value.toFixed(2);
    }

    return value.toFixed(4);
  }

  /**
   * Aggregates duplicate metric names to latest points so synthesis receives breadth over repetition.
   */
  private latestMetricByName(
    metrics: MetricPointEntity[],
  ): MetricPointEntity[] {
    const latestByName = new Map<string, MetricPointEntity>();

    for (const metric of metrics) {
      const current = latestByName.get(metric.metricName);
      if (!current || metric.asOf > current.asOf) {
        latestByName.set(metric.metricName, metric);
      }
    }

    return Array.from(latestByName.values()).sort(
      (left, right) => right.asOf.getTime() - left.asOf.getTime(),
    );
  }

  /**
   * Converts evidence breadth and freshness into a deterministic score for easier regression tracking.
   */
  private computeScore(
    docsCount: number,
    metricsCount: number,
    filingsCount: number,
  ): number {
    const docsContribution = Math.min(40, docsCount * 2.5);
    const metricsContribution = Math.min(30, metricsCount * 4);
    const filingsContribution = Math.min(20, filingsCount * 5);
    const triangulationBonus =
      docsCount > 0 && metricsCount > 0 && filingsCount > 0 ? 10 : 0;

    return Math.max(
      0,
      Math.min(
        100,
        Number.parseFloat(
          (
            docsContribution +
            metricsContribution +
            filingsContribution +
            triangulationBonus
          ).toFixed(1),
        ),
      ),
    );
  }

  /**
   * Estimates confidence from evidence breadth plus recency while avoiding overconfident outputs on sparse data.
   */
  private computeConfidence(
    docs: Awaited<ReturnType<DocumentRepositoryPort["listBySymbol"]>>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    now: Date,
  ): number {
    let confidence = 0.3;

    confidence += Math.min(0.2, docs.length * 0.0125);
    confidence += Math.min(0.25, metrics.length * 0.03);
    confidence += Math.min(0.2, filings.length * 0.04);

    const latestDocTime = docs.at(0)?.publishedAt?.getTime() ?? 0;
    const latestMetricTime = metrics.at(0)?.asOf?.getTime() ?? 0;
    const latestFilingTime = filings.at(0)?.filedAt?.getTime() ?? 0;
    const latestEvidenceTime = Math.max(
      latestDocTime,
      latestMetricTime,
      latestFilingTime,
    );

    if (latestEvidenceTime > 0) {
      const hoursOld = (now.getTime() - latestEvidenceTime) / (1000 * 60 * 60);

      if (hoursOld <= 48) {
        confidence += 0.08;
      } else if (hoursOld <= 7 * 24) {
        confidence += 0.05;
      } else if (hoursOld <= 30 * 24) {
        confidence += 0.02;
      }
    }

    return Math.max(
      0.15,
      Math.min(0.95, Number.parseFloat(confidence.toFixed(2))),
    );
  }

  /**
   * Materializes the latest thesis snapshot to provide a stable read model for downstream consumers.
   */
  async run(payload: JobPayload): Promise<void> {
    const [docsRaw, metricsRaw, filingsRaw] = await Promise.all([
      this.documentRepo.listBySymbol(payload.symbol, 15),
      this.metricsRepo.listBySymbol(payload.symbol, 20),
      this.filingsRepo.listBySymbol(payload.symbol, 10),
    ]);

    const docs = this.preferRealProviders(docsRaw);
    const metrics = this.preferRealProviders(metricsRaw);
    const filings = this.preferRealProviders(filingsRaw);

    const latestMetrics = this.latestMetricByName(metrics).slice(0, 8);
    const sourceLines = docs
      .slice(0, 10)
      .map((doc) => `- ${doc.provider}: ${doc.title}`)
      .join("\n");

    const metricLines = latestMetrics
      .map(
        (metric) =>
          `- ${metric.provider}: ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""} (${metric.periodType}, as of ${metric.asOf.toISOString().slice(0, 10)})`,
      )
      .join("\n");

    const filingLines = filings
      .slice(0, 6)
      .map(
        (filing) =>
          `- ${filing.provider}: ${filing.filingType} filed ${filing.filedAt.toISOString().slice(0, 10)}${filing.accessionNo ? ` accession ${filing.accessionNo}` : ""}${filing.docUrl ? ` (${filing.docUrl})` : ""}`,
      )
      .join("\n");

    const thesis = await this.llm.synthesize(
      [
        `Create an investing thesis for ${payload.symbol}.`,
        "Use only the evidence below.",
        "",
        "News headlines:",
        sourceLines || "- none",
        "",
        "Market metrics:",
        metricLines || "- none",
        "",
        "Regulatory filings:",
        filingLines || "- none",
        "",
        "Output requirements:",
        "- Explain what changed in shareholder/institutional dynamics.",
        "- Connect valuation or growth interpretation to provided metrics when available.",
        "- Use filings to support or challenge narrative when available.",
        "- Explicitly state missing evidence if a section is empty.",
      ].join("\n"),
    );

    const now = this.clock.now();
    const score = this.computeScore(
      docs.length,
      latestMetrics.length,
      filings.length,
    );
    const confidence = this.computeConfidence(
      docs,
      latestMetrics,
      filings,
      now,
    );

    await this.snapshotRepo.save({
      id: this.ids.next(),
      symbol: payload.symbol,
      horizon: "12m",
      score,
      thesis,
      risks: ["Execution risk", "Macro risk"],
      catalysts: ["Product cycle", "Margin expansion"],
      valuationView: "Neutral until more evidence",
      confidence,
      sources: this.uniqueSources(docs, latestMetrics, filings),
      createdAt: now,
    });
  }
}

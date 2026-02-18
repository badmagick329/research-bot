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
    const docsContribution = Math.min(30, docsCount * 1.5);
    const metricsContribution = Math.min(35, metricsCount * 4.5);
    const filingsContribution = Math.min(25, filingsCount * 4);
    const evidenceTypes = [docsCount > 0, metricsCount > 0, filingsCount > 0];
    const coverageBonus =
      (evidenceTypes.filter(Boolean).length / evidenceTypes.length) * 10;

    return Math.max(
      0,
      Math.min(
        100,
        Number.parseFloat(
          (
            docsContribution +
            metricsContribution +
            filingsContribution +
            coverageBonus
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
    let confidence = 0.25;

    const evidenceTypes = [
      docs.length > 0,
      metrics.length > 0,
      filings.length > 0,
    ];
    confidence += evidenceTypes.filter(Boolean).length * 0.12;

    const documentProviderCount = new Set(docs.map((doc) => doc.provider)).size;
    confidence += Math.min(0.08, documentProviderCount * 0.03);

    const coreMetricNames = new Set([
      "market_cap",
      "price_to_earnings",
      "revenue_growth_yoy",
      "profit_margin",
      "eps",
    ]);
    const coveredMetricNames = new Set(
      metrics
        .map((metric) => metric.metricName)
        .filter((metricName) => coreMetricNames.has(metricName)),
    );
    confidence += (coveredMetricNames.size / coreMetricNames.size) * 0.15;

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
      } else {
        confidence -= 0.07;
      }
    }

    if (docs.length === 0) {
      confidence -= 0.06;
    }

    if (metrics.length === 0) {
      confidence -= 0.08;
    }

    if (filings.length === 0) {
      confidence -= 0.04;
    }

    return Math.max(
      0.1,
      Math.min(0.9, Number.parseFloat(confidence.toFixed(2))),
    );
  }

  /**
   * Converts a ratio metric into percentage points so narrative logic can avoid unit ambiguity.
   */
  private asPercent(metric: MetricPointEntity | undefined): number | null {
    if (!metric || !Number.isFinite(metric.metricValue)) {
      return null;
    }

    return metric.metricValue * 100;
  }

  /**
   * Derives valuation framing from available core metrics so summary labels reflect evidence.
   */
  private deriveValuationView(metrics: MetricPointEntity[]): string {
    const byName = new Map(
      metrics.map((metric) => [metric.metricName, metric]),
    );
    const pe = byName.get("price_to_earnings")?.metricValue;
    const growthPercent = this.asPercent(byName.get("revenue_growth_yoy"));

    if (typeof pe !== "number") {
      return "Neutral; valuation multiples unavailable";
    }

    if (pe >= 50 && (growthPercent === null || growthPercent < 12)) {
      return "Cautious; elevated multiple requires stronger growth follow-through";
    }

    if (pe <= 25 && growthPercent !== null && growthPercent >= 10) {
      return "Constructive; growth appears reasonable versus current multiple";
    }

    return "Neutral; valuation balanced versus current growth evidence";
  }

  /**
   * Generates evidence-driven risk labels so downstream readers can audit risk rationale quickly.
   */
  private deriveRisks(
    docs: Awaited<ReturnType<DocumentRepositoryPort["listBySymbol"]>>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): string[] {
    const risks: string[] = [];
    const byName = new Map(
      metrics.map((metric) => [metric.metricName, metric]),
    );
    const pe = byName.get("price_to_earnings")?.metricValue;
    const growthPercent = this.asPercent(byName.get("revenue_growth_yoy"));

    if (metrics.length === 0) {
      risks.push("Data coverage risk (missing market metrics)");
    }

    if (filings.length === 0) {
      risks.push("Regulatory evidence gap risk");
    }

    if (docs.length < 3) {
      risks.push("Narrative concentration risk (limited headline breadth)");
    }

    if (
      typeof pe === "number" &&
      pe >= 50 &&
      (growthPercent === null || growthPercent < 10)
    ) {
      risks.push("Multiple compression risk");
    }

    if (risks.length === 0) {
      risks.push("Execution risk");
      risks.push("Macro risk");
    }

    return risks.slice(0, 4);
  }

  /**
   * Derives near-term catalysts from observed evidence coverage so catalysts avoid generic repetition.
   */
  private deriveCatalysts(
    docs: Awaited<ReturnType<DocumentRepositoryPort["listBySymbol"]>>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): string[] {
    const catalysts: string[] = [];
    const byName = new Map(
      metrics.map((metric) => [metric.metricName, metric]),
    );
    const growthPercent = this.asPercent(byName.get("revenue_growth_yoy"));

    if (growthPercent !== null && growthPercent >= 10) {
      catalysts.push("Sustained top-line growth confirmation");
    }

    if (filings.length > 0) {
      catalysts.push("Upcoming filing disclosures and guidance updates");
    }

    if (docs.length >= 5) {
      catalysts.push("Execution updates from product and demand headlines");
    }

    if (catalysts.length === 0) {
      catalysts.push("Product cycle");
      catalysts.push("Margin expansion");
    }

    return catalysts.slice(0, 4);
  }

  /**
   * Materializes the latest thesis snapshot to provide a stable read model for downstream consumers.
   */
  async run(payload: JobPayload): Promise<void> {
    const [docsRaw, metricsRaw, filingsRaw] = await Promise.all([
      this.documentRepo.listBySymbol(payload.symbol, 15, payload.runId),
      this.metricsRepo.listBySymbol(payload.symbol, 20, payload.runId),
      this.filingsRepo.listBySymbol(payload.symbol, 10, payload.runId),
    ]);

    const docs = this.preferRealProviders(docsRaw);
    const metrics = this.preferRealProviders(metricsRaw);
    const filings = this.preferRealProviders(filingsRaw);

    const latestMetrics = this.latestMetricByName(metrics).slice(0, 8);
    const sourceLines = docs
      .slice(0, 10)
      .map((doc, index) => `- N${index + 1} ${doc.provider}: ${doc.title}`)
      .join("\n");

    const metricLines = latestMetrics
      .map(
        (metric, index) =>
          `- M${index + 1} ${metric.provider}: ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""} (${metric.periodType}, as of ${metric.asOf.toISOString().slice(0, 10)})`,
      )
      .join("\n");

    const filingLines = filings
      .slice(0, 6)
      .map(
        (filing, index) =>
          `- F${index + 1} ${filing.provider}: ${filing.filingType} filed ${filing.filedAt.toISOString().slice(0, 10)}${filing.accessionNo ? ` accession ${filing.accessionNo}` : ""}${filing.docUrl ? ` (${filing.docUrl})` : ""}`,
      )
      .join("\n");

    const metricsDiagnosticsLine = payload.metricsDiagnostics
      ? `- provider=${payload.metricsDiagnostics.provider}, status=${payload.metricsDiagnostics.status}, metricCount=${payload.metricsDiagnostics.metricCount}${payload.metricsDiagnostics.reason ? `, reason=${payload.metricsDiagnostics.reason}` : ""}${typeof payload.metricsDiagnostics.httpStatus === "number" ? `, httpStatus=${payload.metricsDiagnostics.httpStatus}` : ""}`
      : "- unavailable";

    const thesis = await this.llm.synthesize(
      [
        `Create an investing thesis for ${payload.symbol}.`,
        "Use only the evidence below.",
        "Do not invent facts, numbers, shareholders, or events not present in evidence.",
        "When evidence is missing or weak, explicitly state uncertainty and data gaps.",
        "",
        "Metrics fetch diagnostics:",
        metricsDiagnosticsLine,
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
        "- Return Markdown with headings: Overview, Shareholder/Institutional Dynamics, Valuation and Growth Interpretation, Regulatory Filings, Missing Evidence, Conclusion.",
        "- For each section, tie claims to one or more evidence items (N#, M#, F# labels).",
        "- Explain what changed in shareholder/institutional dynamics.",
        "- Connect valuation or growth interpretation to provided metrics when available.",
        "- Use filings to support or challenge narrative when available.",
        "- Explicitly state missing evidence if a section is empty.",
        "- If metrics diagnostics indicate missing or degraded metrics, mention that limitation in Missing Evidence.",
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
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      horizon: "12m",
      score,
      thesis,
      risks: this.deriveRisks(docs, latestMetrics, filings),
      catalysts: this.deriveCatalysts(docs, latestMetrics, filings),
      valuationView: this.deriveValuationView(latestMetrics),
      confidence,
      sources: this.uniqueSources(docs, latestMetrics, filings),
      diagnostics: {
        metrics: payload.metricsDiagnostics,
      },
      createdAt: now,
    });
  }
}

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
import type { DocumentEntity } from "../../core/entities/document";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { FilingEntity } from "../../core/entities/filing";
import type {
  ResolvedCompanyIdentity,
  SnapshotProviderFailureDiagnostics,
  SnapshotStageDiagnostics,
} from "../../core/entities/research";

type RankedDocument = {
  doc: DocumentEntity;
  score: number;
  isRelevant: boolean;
};

type RelevanceSelection = {
  selected: DocumentEntity[];
  relevantHeadlinesCount: number;
  selectedRelevantCount: number;
  lowRelevance: boolean;
};

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
   * Renders provider failure diagnostics into stable prompt lines so missing evidence is explicit to synthesis.
   */
  private formatProviderFailures(
    failures: SnapshotProviderFailureDiagnostics[] | undefined,
  ): string {
    if (!failures || failures.length === 0) {
      return "- none";
    }

    return failures
      .map((failure) => {
        const httpStatusPart =
          typeof failure.httpStatus === "number"
            ? `, httpStatus=${failure.httpStatus}`
            : "";
        const retryablePart =
          typeof failure.retryable === "boolean"
            ? `, retryable=${failure.retryable}`
            : "";
        return `- source=${failure.source}, provider=${failure.provider}, status=${failure.status}, itemCount=${failure.itemCount}${httpStatusPart}${retryablePart}, reason=${failure.reason}`;
      })
      .join("\n");
  }

  /**
   * Renders stage degradation diagnostics so final snapshot narrative can clearly explain pipeline quality loss.
   */
  private formatStageIssues(issues: SnapshotStageDiagnostics[] | undefined) {
    if (!issues || issues.length === 0) {
      return "- none";
    }

    return issues
      .map((issue) => {
        const providerPart = issue.provider
          ? `, provider=${issue.provider}`
          : "";
        const codePart = issue.code ? `, code=${issue.code}` : "";
        const retryablePart =
          typeof issue.retryable === "boolean"
            ? `, retryable=${issue.retryable}`
            : "";
        return `- stage=${issue.stage}, status=${issue.status}${providerPart}${codePart}${retryablePart}, reason=${issue.reason}`;
      })
      .join("\n");
  }

  /**
   * Injects canonical issuer identity into synthesis context so sparse evidence runs remain company-grounded.
   */
  private formatIdentityContext(identity: ResolvedCompanyIdentity | undefined) {
    if (!identity) {
      return "- unresolved";
    }

    const aliases =
      identity.aliases.length > 0 ? identity.aliases.join(", ") : "none";
    return [
      `- requestedSymbol=${identity.requestedSymbol}`,
      `- canonicalSymbol=${identity.canonicalSymbol}`,
      `- companyName=${identity.companyName}`,
      `- aliases=${aliases}`,
      `- confidence=${identity.confidence.toFixed(2)}`,
      `- resolutionSource=${identity.resolutionSource}`,
      identity.exchange ? `- exchange=${identity.exchange}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
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
    relevanceCoverage: number,
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

    if (relevanceCoverage >= 0.7) {
      confidence += 0.04;
    } else if (relevanceCoverage < 0.4 && docs.length > 0) {
      confidence -= 0.05;
    }

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
   * Extracts lowercase ticker-related strings from provider payloads to help relevance ranking.
   */
  private extractPayloadTickerHints(rawPayload: unknown): string[] {
    if (!rawPayload || typeof rawPayload !== "object") {
      return [];
    }

    const payload = rawPayload as Record<string, unknown>;
    const hints: string[] = [];

    const related = payload.related;
    if (typeof related === "string") {
      hints.push(
        ...related
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      );
    }

    const tickerSentiment = payload.ticker_sentiment;
    if (Array.isArray(tickerSentiment)) {
      tickerSentiment.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
          return;
        }

        const ticker = (entry as Record<string, unknown>).ticker;
        if (typeof ticker === "string" && ticker.trim().length > 0) {
          hints.push(ticker.trim().toLowerCase());
        }
      });
    }

    const symbols = payload.symbols;
    if (Array.isArray(symbols)) {
      symbols.forEach((value) => {
        if (typeof value === "string" && value.trim().length > 0) {
          hints.push(value.trim().toLowerCase());
        }
      });
    }

    return hints;
  }

  /**
   * Builds issuer tokens so relevance checks can score symbol, aliases, and company-name mentions deterministically.
   */
  private buildIssuerTokens(
    symbol: string,
    identity: ResolvedCompanyIdentity | undefined,
  ): string[] {
    const tokens = new Set<string>();

    tokens.add(symbol.toLowerCase());
    if (identity) {
      tokens.add(identity.canonicalSymbol.toLowerCase());
      tokens.add(identity.requestedSymbol.toLowerCase());
      identity.aliases.forEach((alias) => tokens.add(alias.toLowerCase()));
      tokens.add(identity.companyName.toLowerCase());
    }

    return Array.from(tokens).filter((token) => token.length >= 2);
  }

  /**
   * Scores a headline for issuer relevance so synthesis evidence prioritizes company-specific context.
   */
  private scoreDocumentRelevance(
    doc: DocumentEntity,
    issuerTokens: string[],
  ): RankedDocument {
    const title = doc.title.toLowerCase();
    const summary = (doc.summary ?? "").toLowerCase();
    const content = doc.content.toLowerCase();
    const payloadHints = this.extractPayloadTickerHints(doc.rawPayload);

    let score = 0;

    issuerTokens.forEach((token) => {
      if (title.includes(token)) {
        score += 4;
      }

      if (summary.includes(token) || content.includes(token)) {
        score += 2;
      }

      if (payloadHints.includes(token)) {
        score += 3;
      }
    });

    const noisyHeadlineTerms = [
      "stocks to buy",
      "premarket",
      "wall street",
      "social buzz",
      "equity investors",
      "asia up",
      "europe off",
      "etf",
      "net worth",
    ];

    noisyHeadlineTerms.forEach((term) => {
      if (title.includes(term)) {
        score -= 4;
      }
    });

    if (!doc.url || doc.url.trim().length === 0) {
      score -= 1;
    }

    const isRelevant = score >= 5;
    return { doc, score, isRelevant };
  }

  /**
   * Selects the most issuer-relevant headlines and tracks coverage diagnostics for prompt guidance.
   */
  private selectRelevantDocuments(
    docs: DocumentEntity[],
    symbol: string,
    identity: ResolvedCompanyIdentity | undefined,
  ): RelevanceSelection {
    if (docs.length === 0) {
      return {
        selected: [],
        relevantHeadlinesCount: 0,
        selectedRelevantCount: 0,
        lowRelevance: true,
      };
    }

    const issuerTokens = this.buildIssuerTokens(symbol, identity);
    const ranked = docs
      .map((doc) => this.scoreDocumentRelevance(doc, issuerTokens))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.doc.publishedAt.getTime() - left.doc.publishedAt.getTime();
      });

    const relevant = ranked.filter((item) => item.isRelevant);
    const selectedRanked =
      relevant.length > 0 ? relevant.slice(0, 10) : ranked.slice(0, 5);
    const selectedRelevantCount = selectedRanked.filter(
      (item) => item.isRelevant,
    ).length;
    const lowRelevance =
      selectedRanked.length === 0 ||
      selectedRelevantCount < 3 ||
      selectedRelevantCount / selectedRanked.length < 0.5;

    return {
      selected: selectedRanked.map((item) => item.doc),
      relevantHeadlinesCount: relevant.length,
      selectedRelevantCount,
      lowRelevance,
    };
  }

  /**
   * Decides whether synthesis should force identity-uncertainty language based on identity type plus evidence signals.
   */
  private shouldForceIdentityUncertainty(
    identity: ResolvedCompanyIdentity | undefined,
    selection: RelevanceSelection,
  ): boolean {
    if (!identity) {
      return true;
    }

    if (identity.resolutionSource === "manual_map") {
      return false;
    }

    if (identity.confidence >= 0.6) {
      return false;
    }

    return selection.selectedRelevantCount === 0;
  }

  /**
   * Builds the primary synthesis prompt so initial and repair attempts share one consistent evidence contract.
   */
  private buildSynthesisPrompt(args: {
    synthesisTarget: string;
    identityLines: string;
    metricsDiagnosticsLine: string;
    providerFailureLines: string;
    stageIssueLines: string;
    sourceLines: string;
    metricLines: string;
    filingLines: string;
    relevanceSelection: RelevanceSelection;
    shouldForceIdentityUncertainty: boolean;
  }): string {
    const relevanceCoverage =
      args.relevanceSelection.selected.length === 0
        ? "0/0"
        : `${args.relevanceSelection.selectedRelevantCount}/${args.relevanceSelection.selected.length}`;

    return [
      `Create an investing thesis for ${args.synthesisTarget}.`,
      "Use only the evidence below.",
      "Do not invent facts, numbers, shareholders, or events not present in evidence.",
      "When evidence is missing or weak, explicitly state uncertainty and data gaps.",
      "Cite each major claim with one or more evidence labels (N#, M#, F#).",
      "Do not leave Conclusion uncited.",
      "Avoid repeating the same uncertainty sentence across sections.",
      "",
      "Resolved company identity:",
      args.identityLines,
      "",
      "Metrics fetch diagnostics:",
      args.metricsDiagnosticsLine,
      "",
      "Provider failures:",
      args.providerFailureLines,
      "",
      "Pipeline stage issues:",
      args.stageIssueLines,
      "",
      "News relevance diagnostics:",
      `- relevantHeadlinesCount=${args.relevanceSelection.relevantHeadlinesCount}`,
      `- relevanceCoverage=${relevanceCoverage}`,
      `- lowRelevance=${args.relevanceSelection.lowRelevance}`,
      "",
      "News headlines:",
      args.sourceLines || "- none",
      "",
      "Market metrics:",
      args.metricLines || "- none",
      "",
      "Regulatory filings:",
      args.filingLines || "- none",
      "",
      "Output requirements:",
      "- Return Markdown with headings: Overview, Shareholder/Institutional Dynamics, Valuation and Growth Interpretation, Regulatory Filings, Missing Evidence, Conclusion.",
      "- For each section, tie claims to one or more evidence items (N#, M#, F# labels).",
      "- Explain what changed in shareholder/institutional dynamics.",
      "- Connect valuation or growth interpretation to provided metrics when available.",
      "- Use filings to support or challenge narrative when available.",
      "- Explicitly state missing evidence if a section is empty.",
      "- If metrics diagnostics indicate missing or degraded metrics, mention that limitation in Missing Evidence.",
      "- If provider failures or pipeline stage issues are present, call them out explicitly in Missing Evidence.",
      "- If lowRelevance=true, explicitly state that weak issuer-specific headline relevance limits confidence.",
      "- Treat listed aliases as the same issuer unless evidence explicitly contradicts this.",
      args.shouldForceIdentityUncertainty
        ? "- Explicitly mention identity uncertainty in Missing Evidence."
        : "- Never describe the symbol as a placeholder or unknown identifier.",
    ].join("\n");
  }

  /**
   * Validates synthesis output structure and citation density so weak drafts can be repaired before persistence.
   */
  private validateThesis(
    thesis: string,
    hasEvidence: boolean,
    shouldForceIdentityUncertainty: boolean,
  ): string[] {
    const issues: string[] = [];

    const requiredHeadings = [
      "# Overview",
      "# Shareholder/Institutional Dynamics",
      "# Valuation and Growth Interpretation",
      "# Regulatory Filings",
      "# Missing Evidence",
      "# Conclusion",
    ];

    requiredHeadings.forEach((heading) => {
      if (!thesis.includes(heading)) {
        issues.push(`Missing heading: ${heading}`);
      }
    });

    const citationMatches = thesis.match(/\b[NMF]\d+\b/g) ?? [];
    if (hasEvidence && citationMatches.length < 4) {
      issues.push("Citation density is too low for available evidence.");
    }

    if (hasEvidence) {
      const sections = thesis
        .split("# ")
        .map((block) => block.trim())
        .filter(Boolean);
      sections.forEach((section) => {
        if (!/\b[NMF]\d+\b/.test(section)) {
          issues.push(`Section missing citation: ${section.split("\n")[0]}`);
        }
      });
    }

    const uncertaintyLineCount = thesis
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.includes("uncertain") || line.includes("missing evidence"))
      .length;
    if (uncertaintyLineCount > 6) {
      issues.push("Uncertainty language is repetitive across sections.");
    }

    const forbiddenIdentityPattern = /(placeholder|unknown identifier)/i;
    if (!shouldForceIdentityUncertainty && forbiddenIdentityPattern.test(thesis)) {
      issues.push(
        "Contains forbidden identity wording despite sufficient identity confidence.",
      );
    }

    return issues;
  }

  /**
   * Builds a one-shot repair prompt so invalid first drafts can be corrected without extra pipeline stages.
   */
  private buildRepairPrompt(
    basePrompt: string,
    draftThesis: string,
    issues: string[],
  ): string {
    return [
      "Repair this thesis draft by fixing all validation failures.",
      "Keep the same required headings and only use provided evidence.",
      "",
      "Validation failures:",
      ...issues.map((issue) => `- ${issue}`),
      "",
      "Original synthesis prompt:",
      basePrompt,
      "",
      "Current thesis draft:",
      draftThesis,
    ].join("\n");
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

    const relevanceSelection = this.selectRelevantDocuments(
      docs,
      payload.symbol,
      payload.resolvedIdentity,
    );
    const selectedDocs = relevanceSelection.selected;

    const latestMetrics = this.latestMetricByName(metrics).slice(0, 8);
    const sourceLines = selectedDocs
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
    const providerFailureLines = this.formatProviderFailures(
      payload.providerFailures,
    );
    const stageIssueLines = this.formatStageIssues(payload.stageIssues);
    const identityLines = this.formatIdentityContext(payload.resolvedIdentity);
    const synthesisTarget = payload.resolvedIdentity
      ? `${payload.resolvedIdentity.companyName} (${payload.resolvedIdentity.canonicalSymbol})`
      : payload.symbol;
    const shouldForceIdentityUncertainty = this.shouldForceIdentityUncertainty(
      payload.resolvedIdentity,
      relevanceSelection,
    );

    const prompt = this.buildSynthesisPrompt({
      synthesisTarget,
      identityLines,
      metricsDiagnosticsLine,
      providerFailureLines,
      stageIssueLines,
      sourceLines,
      metricLines,
      filingLines,
      relevanceSelection,
      shouldForceIdentityUncertainty,
    });

    const thesisResult = await this.llm.synthesize(prompt);

    if (thesisResult.isErr()) {
      throw new Error(
        `Synthesis failed due to LLM error: ${thesisResult.error.message}`,
      );
    }

    let thesis = thesisResult.value;
    const validationIssues = this.validateThesis(
      thesis,
      selectedDocs.length + latestMetrics.length + filings.length > 0,
      shouldForceIdentityUncertainty,
    );

    if (validationIssues.length > 0) {
      const repairPrompt = this.buildRepairPrompt(prompt, thesis, validationIssues);
      const repairedResult = await this.llm.synthesize(repairPrompt);
      if (repairedResult.isErr()) {
        throw new Error(
          `Synthesis repair failed due to LLM error: ${repairedResult.error.message}`,
        );
      }

      const repairedThesis = repairedResult.value;
      const repairedIssues = this.validateThesis(
        repairedThesis,
        selectedDocs.length + latestMetrics.length + filings.length > 0,
        shouldForceIdentityUncertainty,
      );
      thesis = repairedIssues.length <= validationIssues.length ? repairedThesis : thesis;
    }

    const now = this.clock.now();
    const score = this.computeScore(
      selectedDocs.length,
      latestMetrics.length,
      filings.length,
    );
    const relevanceCoverage =
      selectedDocs.length === 0
        ? 0
        : relevanceSelection.selectedRelevantCount / selectedDocs.length;
    const confidence = this.computeConfidence(
      selectedDocs,
      latestMetrics,
      filings,
      now,
      relevanceCoverage,
    );

    await this.snapshotRepo.save({
      id: this.ids.next(),
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      horizon: "12m",
      score,
      thesis,
      risks: this.deriveRisks(selectedDocs, latestMetrics, filings),
      catalysts: this.deriveCatalysts(selectedDocs, latestMetrics, filings),
      valuationView: this.deriveValuationView(latestMetrics),
      confidence,
      sources: this.uniqueSources(selectedDocs, latestMetrics, filings),
      diagnostics: {
        metrics: payload.metricsDiagnostics,
        providerFailures: payload.providerFailures,
        stageIssues: payload.stageIssues,
        identity: payload.resolvedIdentity,
      },
      createdAt: now,
    });
  }
}

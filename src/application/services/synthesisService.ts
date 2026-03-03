import type {
  JobPayload,
  DocumentRepositoryPort,
  MetricsRepositoryPort,
  FilingsRepositoryPort,
  EmbeddingPort,
  EmbeddingMemoryRepositoryPort,
  EmbeddingMemoryMatch,
  LlmPort,
  SnapshotRepositoryPort,
  ClockPort,
  IdGeneratorPort,
} from "../../core/ports/outboundPorts";
import type {
  DocumentEntity,
  NewsEvidenceClass,
} from "../../core/entities/document";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { FilingEntity } from "../../core/entities/filing";
import type {
  ActionDecision,
  ConfidenceDecomposition,
  DecisionScoreBreakdown,
  FalsificationCondition,
  HorizonBucket,
  InvestorCatalyst,
  InvestorDriver,
  InvestorKpi,
  InvestorViewV2,
  KpiCoverageDiagnostics,
  KpiTemplateName,
  PositionSizing,
  ResolvedCompanyIdentity,
  SignalPack,
  SnapshotProviderFailureDiagnostics,
  SnapshotStageDiagnostics,
  SufficiencyDiagnostics,
} from "../../core/entities/research";
import {
  type NewsDocumentClass,
  type NewsScoredItem,
  scoreNewsCandidate,
} from "./newsScoringV2";
import {
  appendStageIssue,
  toBoundaryStageIssue,
} from "./shared/stageIssue";
import { DeterministicSynthesisEvidenceSelector } from "./synthesis/evidenceSelection";
import { DeterministicSynthesisDecisionPolicy } from "./synthesis/decisionPolicy";
import { DeterministicNormalizedSignalService } from "./synthesis/normalizedSignalService";
import { SynthesisPromptBuilder } from "./synthesis/promptBuilder";
import { DeterministicSynthesisThesisGuard } from "./synthesis/thesisGuard";
import { SynthesisInvestorViewBuilder } from "./synthesis/investorViewBuilder";
import type {
  SynthesisDecisionPolicyPort,
  SynthesisEvidenceSelectorPort,
  SynthesisInvestorViewBuilderPort,
  SynthesisNormalizedSignalPort,
  SynthesisPromptBuilderPort,
  SynthesisThesisGuardPort,
} from "./synthesis/types";

type RankedDocument = {
  doc: DocumentEntity;
  score: number;
  isRelevant: boolean;
};

type RelevanceSelection = {
  selected: DocumentEntity[];
  classifiedDocuments: DocumentEntity[];
  selectedNewsLabels: string[];
  newsLabelByDocumentId: Map<string, string>;
  issuerAnchorPresent: boolean;
  includedByClass: Record<NewsEvidenceClass, number>;
  excludedByClass: Record<NewsEvidenceClass, number>;
  excludedByClassAndReason: Record<string, Record<string, number>>;
  relevantHeadlinesCount: number;
  selectedRelevantCount: number;
  lowRelevance: boolean;
  totalHeadlinesCount: number;
  issuerMatchedHeadlinesCount: number;
  excludedHeadlinesCount: number;
  excludedHeadlineReasons: ExcludedHeadlineReason[];
  excludedHeadlineReasonSamples: string[];
  averageCompositeScore: number;
  excludedByReason: Record<string, number>;
  issuerAnchorCount: number;
  prefilterClassCountsBefore: Record<NewsDocumentClass, number>;
  prefilterClassCountsAfter: Record<NewsDocumentClass, number>;
  issuerAnchorAvailable: boolean;
  issuerAnchorAvailableCount: number;
  issuerMatchDiagnostics: {
    title: number;
    summary: number;
    content: number;
    payload: number;
    payloadOnlyRejected: number;
  };
  payloadOnlyRecovery: {
    payloadOnlyRatio: number;
    recoveryInvoked: boolean;
    recoveryStatus: "not_needed" | "recovered" | "not_recovered";
    recoveryReason: string;
    issuerAnchorAvailableBefore: boolean;
    issuerAnchorAvailableAfter: boolean;
    issuerAnchorSelectedBefore: number;
    issuerAnchorSelectedAfter: number;
    metricHeavyDueToNarrativeGap: boolean;
  };
  scoreBreakdownSample: Array<{
    title: string;
    composite: number;
    components: {
      issuerMatchScore: number;
      economicMaterialityScore: number;
      noveltyScore: number;
      horizonRelevanceScore: number;
      kpiLinkageScore: number;
      sourceQualityScore: number;
    };
    included: boolean;
    reason?: string;
    documentClass: NewsDocumentClass;
    confidenceBand: string;
  }>;
};

type ThesisDecision = "buy" | "watch" | "avoid";
type RelevanceMode = "high_precision" | "balanced";
type IssuerIdentityPatterns = {
  symbolExactTokens: Set<string>;
  symbolPhraseTokens: Set<string>;
  aliasExactTokens: Set<string>;
  aliasPhraseTokens: Set<string>;
  companyExactTokens: Set<string>;
  companyPhraseTokens: Set<string>;
  exactTokens: Set<string>;
  phraseTokens: Set<string>;
};
type IssuerMatchField = "title" | "summary" | "content" | "payload" | "alias" | "company";
type IssuerMatchResult = {
  matched: boolean;
  fieldsMatched: number;
  matchedFields: IssuerMatchField[];
  payloadOnlyMatch: boolean;
  reason?: ExcludedHeadlineReason;
};
type ExcludedHeadlineReason =
  | "no_issuer_identity_match"
  | "payload_only_issuer_match"
  | "below_relevance_threshold"
  | "duplicate_title"
  | "duplicate_url"
  | "market_context_prefiltered"
  | "generic_market_noise_prefiltered"
  | "explicit_market_noise_pattern"
  | "issuer_noise_or_adjacent_context"
  | "below_materiality_threshold"
  | "below_kpi_linkage_threshold"
  | "below_composite_threshold"
  | "low_source_quality"
  | "stale_for_horizon"
  | "read_through_without_issuer_anchor"
  | "read_through_capped";
type ActionMatrixRow = {
  signalId: string;
  label: string;
  currentValue: string;
  triggerKind: "metric" | "filing" | "coverage";
  condition: string;
  conditionDirection: "downside" | "upside" | "neutral";
  actionClass: "defensive" | "constructive" | "neutral";
  action: string;
  citations: string[];
  hasNumericThreshold: boolean;
};
type ThesisQualityScore = {
  score: number;
  failedChecks: string[];
};

type KpiCoverageComputation = {
  selectedCurrentKpiNames: string[];
  diagnostics: KpiCoverageDiagnostics;
};

const evidenceClassSortOrder: Record<NewsEvidenceClass, number> = {
  issuer: 0,
  peer: 1,
  supply_chain: 2,
  customer: 3,
  industry: 4,
};

/**
 * Preserves legacy gate-failure shape so existing diagnostics consumers keep working during decision rework.
 */
const insufficiencyReasonsToFailures = (reasons: string[]): string[] =>
  reasons.length > 0 ? reasons : ["insufficient_evidence"];

/**
 * Consolidates evidence into a durable snapshot so decision outputs remain traceable to stored sources.
 */
export class SynthesisService {
  private readonly memoryTopK = 6;
  private readonly memoryWindowDays = 90;
  private readonly memoryMinSimilarity = 0.72;
  private readonly relevanceMode: RelevanceMode;
  private readonly minRelevanceScore: number;
  private readonly issuerMatchMinFields: number;
  private readonly thesisTriggerMinNumeric: number;
  private readonly thesisGenericPhraseMax: number;
  private readonly thesisMinCitationCoveragePct: number;
  private readonly thesisQualityMinScore: number;
  private readonly kpiCarryForwardMaxAgeDays: number;
  private readonly coreKpiMinRequired: number;
  private readonly graceAllowOnSectorWeakness: boolean;
  private readonly newsV2MinCompositeScore: number;
  private readonly newsV2MinMaterialityScore: number;
  private readonly newsV2MinKpiLinkageScore: number;
  private readonly newsV2MaxItems: number;
  private readonly newsV2SourceQualityMode: "default";
  private readonly evidenceSelector: SynthesisEvidenceSelectorPort;
  private readonly normalizedSignalService: SynthesisNormalizedSignalPort;
  private readonly decisionPolicy: SynthesisDecisionPolicyPort;
  private readonly promptBuilder: SynthesisPromptBuilderPort;
  private readonly thesisGuard: SynthesisThesisGuardPort;
  private readonly investorViewBuilder: SynthesisInvestorViewBuilderPort;

  constructor(
    private readonly documentRepo: DocumentRepositoryPort,
    private readonly metricsRepo: MetricsRepositoryPort,
    private readonly filingsRepo: FilingsRepositoryPort,
    private readonly embeddingPort: EmbeddingPort,
    private readonly embeddingMemoryRepo: EmbeddingMemoryRepositoryPort,
    private readonly snapshotRepo: SnapshotRepositoryPort,
    private readonly llm: LlmPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    options?: {
      relevanceMode?: RelevanceMode;
      minRelevanceScore?: number;
      issuerMatchMinFields?: number;
      thesisTriggerMinNumeric?: number;
      thesisGenericPhraseMax?: number;
      thesisMinCitationCoveragePct?: number;
      thesisQualityMinScore?: number;
      kpiCarryForwardMaxAgeDays?: number;
      coreKpiMinRequired?: number;
      graceAllowOnSectorWeakness?: boolean;
      newsV2MinCompositeScore?: number;
      newsV2MinMaterialityScore?: number;
      newsV2MinKpiLinkageScore?: number;
      newsV2MaxItems?: number;
      newsV2SourceQualityMode?: "default";
    },
  ) {
    this.relevanceMode = options?.relevanceMode ?? "high_precision";
    this.minRelevanceScore = options?.minRelevanceScore ?? 7;
    this.issuerMatchMinFields = options?.issuerMatchMinFields ?? 1;
    this.thesisTriggerMinNumeric = options?.thesisTriggerMinNumeric ?? 3;
    this.thesisGenericPhraseMax = options?.thesisGenericPhraseMax ?? 0;
    this.thesisMinCitationCoveragePct = options?.thesisMinCitationCoveragePct ?? 80;
    this.thesisQualityMinScore = options?.thesisQualityMinScore ?? 75;
    this.kpiCarryForwardMaxAgeDays = options?.kpiCarryForwardMaxAgeDays ?? 90;
    this.coreKpiMinRequired = options?.coreKpiMinRequired ?? 2;
    this.graceAllowOnSectorWeakness =
      options?.graceAllowOnSectorWeakness ?? true;
    this.newsV2MinCompositeScore = options?.newsV2MinCompositeScore ?? 65;
    this.newsV2MinMaterialityScore = options?.newsV2MinMaterialityScore ?? 50;
    this.newsV2MinKpiLinkageScore = options?.newsV2MinKpiLinkageScore ?? 40;
    this.newsV2MaxItems = options?.newsV2MaxItems ?? 10;
    this.newsV2SourceQualityMode = options?.newsV2SourceQualityMode ?? "default";
    this.evidenceSelector = new DeterministicSynthesisEvidenceSelector(
      this.relevanceMode,
      this.issuerMatchMinFields,
      this.newsV2MinCompositeScore,
      this.newsV2MinMaterialityScore,
      this.newsV2MinKpiLinkageScore,
      this.newsV2MaxItems,
      this.newsV2SourceQualityMode,
    );
    this.normalizedSignalService = new DeterministicNormalizedSignalService();
    this.decisionPolicy = new DeterministicSynthesisDecisionPolicy(
      this.thesisTriggerMinNumeric,
      this.graceAllowOnSectorWeakness,
      (metric) => this.formatMetricValue(metric),
    );
    this.promptBuilder = new SynthesisPromptBuilder((metric) =>
      this.formatMetricValue(metric),
    );
    this.thesisGuard = new DeterministicSynthesisThesisGuard(
      this.thesisTriggerMinNumeric,
      this.thesisMinCitationCoveragePct,
      this.thesisGenericPhraseMax,
      (metric) => this.formatMetricValue(metric),
    );
    this.investorViewBuilder = new SynthesisInvestorViewBuilder(
      (docs, metrics, filings, now, relevanceCoverage) =>
        this.computeConfidence(docs, metrics, filings, now, relevanceCoverage),
      (metric) => this.formatMetricValue(metric),
    );
  }

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
   * Identifies normalized macro metrics so synthesis can apply sector-sensitive inclusion without polluting core KPI ranking.
   */
  private isMacroMetricName(metricName: string): boolean {
    return metricName.startsWith("macro_");
  }

  /**
   * Selects a bounded macro subset by KPI template so investor-facing narrative uses relevant macro context only.
   */
  private selectMacroMetrics(
    metrics: MetricPointEntity[],
    template: KpiTemplateName | undefined,
  ): MetricPointEntity[] {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const selectedNamesByTemplate: Record<KpiTemplateName, string[]> = {
      banks: [
        "macro_fed_funds_rate",
        "macro_us10y_yield",
        "macro_yield_curve_10y_2y",
        "macro_unemployment_rate",
      ],
      retail_consumer: [
        "macro_cpi_yoy",
        "macro_bls_cpi_yoy",
        "macro_unemployment_rate",
        "macro_retail_sales_yoy",
      ],
      semis: [
        "macro_industrial_production_yoy",
        "macro_us10y_yield",
        "macro_cpi_yoy",
      ],
      software_saas: [
        "macro_us10y_yield",
        "macro_fed_funds_rate",
        "macro_unemployment_rate",
      ],
      energy_materials: [
        "macro_wti_oil_price",
        "macro_industrial_production_yoy",
        "macro_cpi_yoy",
      ],
      generic: [
        "macro_fed_funds_rate",
        "macro_cpi_yoy",
        "macro_unemployment_rate",
      ],
    };

    const resolvedTemplate = template ?? "generic";
    const selected: MetricPointEntity[] = [];
    selectedNamesByTemplate[resolvedTemplate].forEach((name) => {
      const metric = byName.get(name);
      if (metric) {
        selected.push(metric);
      }
    });

    return selected.slice(0, 4);
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
   * Builds a compact semantic query from current-run evidence so retrieval stays anchored to active thesis context.
   */
  private buildMemoryQueryText(
    docs: DocumentEntity[],
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): string {
    const headlinePart = docs
      .slice(0, 5)
      .map((doc) => doc.title)
      .join(" | ");
    const metricsPart = metrics
      .slice(0, 5)
      .map(
        (metric) =>
          `${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""}`,
      )
      .join(" | ");
    const filingsPart = filings
      .slice(0, 3)
      .map((filing) => `${filing.filingType} ${filing.filedAt.toISOString().slice(0, 10)}`)
      .join(" | ");

    return [
      headlinePart ? `Headlines: ${headlinePart}` : "",
      metricsPart ? `Metrics: ${metricsPart}` : "",
      filingsPart ? `Filings: ${filingsPart}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Retrieves prior-run semantic matches and degrades gracefully when embedding lookup fails.
   */
  private async fetchCrossRunMemory(
    payload: JobPayload,
    docs: DocumentEntity[],
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    now: Date,
  ): Promise<{ matches: EmbeddingMemoryMatch[]; nextPayload: JobPayload }> {
    const queryText = this.buildMemoryQueryText(docs, metrics, filings);
    if (!queryText) {
      return { matches: [], nextPayload: payload };
    }

    const queryEmbeddingResult = await this.embeddingPort.embedTexts([queryText]);
    if (queryEmbeddingResult.isErr()) {
      return {
        matches: [],
        nextPayload: appendStageIssue(
          payload,
          toBoundaryStageIssue({
            stage: "embed",
            summary: "Cross-run memory degraded",
            error: queryEmbeddingResult.error,
          }),
        ),
      };
    }

    const queryEmbedding = queryEmbeddingResult.value.at(0);
    if (!queryEmbedding) {
      return {
        matches: [],
        nextPayload: appendStageIssue(payload, {
          stage: "embed",
          status: "degraded",
          reason: "Cross-run memory degraded because query embedding was empty.",
          provider: "embedding-memory",
          code: "dimension_mismatch",
          retryable: false,
        }),
      };
    }

    try {
      const matches = await this.embeddingMemoryRepo.findSimilarBySymbol(
        payload.symbol,
        queryEmbedding,
        {
          limit: this.memoryTopK,
          excludeRunId: payload.runId,
          from: new Date(
            now.getTime() - this.memoryWindowDays * 24 * 60 * 60 * 1000,
          ),
          minSimilarity: this.memoryMinSimilarity,
        },
      );

      return { matches, nextPayload: payload };
    } catch (error) {
      return {
        matches: [],
        nextPayload: appendStageIssue(payload, {
          stage: "embed",
          status: "degraded",
          reason: `Cross-run memory degraded due to retrieval error: ${error instanceof Error ? error.message : String(error)}`,
          provider: "embedding-memory",
          code: "provider_error",
          retryable: false,
        }),
      };
    }
  }

  /**
   * Formats memory matches into deterministic prompt labels so synthesis can cite historical context as R# references.
   */
  private formatMemoryLines(matches: EmbeddingMemoryMatch[]): string {
    if (matches.length === 0) {
      return "- none";
    }

    return matches
      .map((match, index) => {
        const snippet = match.content.replace(/\s+/g, " ").trim().slice(0, 220);
        return `- R${index + 1} run=${match.runId ?? "unknown"} similarity=${match.similarity.toFixed(3)} created=${match.createdAt.toISOString().slice(0, 10)}: ${snippet}`;
      })
      .join("\n");
  }

  /**
   * Derives deterministic decision context flags so non-Watch outcomes can be reached only when objective evidence gates pass.
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
   * Merges current-run KPI coverage with fresh prior-run KPI names so evidence gates can tolerate sparse single-run windows.
   */
  private async computeKpiCoverage(args: {
    payload: JobPayload;
    now: Date;
    fallbackSelectedKpiNames: string[];
  }): Promise<KpiCoverageComputation> {
    const currentSelected = args.payload.kpiContext?.selected ?? [];
    const currentSelectedSet = new Set(currentSelected);
    const previousSnapshot = await this.snapshotRepo.latestBySymbol(args.payload.symbol);
    const priorRunSnapshot =
      previousSnapshot?.runId === args.payload.runId ? null : previousSnapshot;
    const previousKpiNames = priorRunSnapshot?.investorViewV2?.keyKpis.map(
      (kpi) => kpi.name,
    ) ?? [];
    const ageDays =
      priorRunSnapshot && priorRunSnapshot.createdAt
        ? Math.floor(
            (args.now.getTime() - priorRunSnapshot.createdAt.getTime()) /
              (24 * 60 * 60 * 1000),
          )
        : null;
    const canCarryForward =
      ageDays !== null &&
      ageDays >= 0 &&
      ageDays <= this.kpiCarryForwardMaxAgeDays;

    const carriedKpis = canCarryForward
      ? previousKpiNames
          .filter((name) => !currentSelectedSet.has(name))
          .map((name) => ({
            name,
            ageDays: ageDays ?? this.kpiCarryForwardMaxAgeDays,
            usedForGate: true,
          }))
      : [];

    const requiredKpis = args.payload.kpiContext?.required ?? [];
    const optionalKpis = args.payload.kpiContext?.optional ?? [];
    const carriedByName = new Set(carriedKpis.map((item) => item.name));
    const coreCurrentCount = requiredKpis.filter((name) =>
      currentSelectedSet.has(name),
    ).length;
    const coreCarriedCount = requiredKpis.filter((name) =>
      carriedByName.has(name),
    ).length;
    const sectorCurrentCount = optionalKpis.filter((name) =>
      currentSelectedSet.has(name),
    ).length;
    const sectorCarriedCount = optionalKpis.filter((name) =>
      carriedByName.has(name),
    ).length;
    const hasSectorWeakness =
      optionalKpis.length > 0 && sectorCurrentCount + sectorCarriedCount < 1;

    return {
      selectedCurrentKpiNames:
        currentSelected.length > 0 ? currentSelected : args.fallbackSelectedKpiNames,
      diagnostics: {
        mode:
          this.graceAllowOnSectorWeakness && hasSectorWeakness
            ? "grace_low_quality"
            : "strict",
        coreRequiredCount:
          requiredKpis.length > 0
            ? Math.min(this.coreKpiMinRequired, requiredKpis.length)
            : 0,
        coreCurrentCount,
        coreCarriedCount,
        sectorExpectedCount: optionalKpis.length,
        sectorCurrentCount,
        sectorCarriedCount,
        carryForwardMaxAgeDays: this.kpiCarryForwardMaxAgeDays,
        carriedKpis,
      },
    };
  }

  /**
   * Enforces a minimum business-KPI floor so conviction does not rely mostly on valuation ratios.
   */
  private hasEnoughBusinessKpis(selectedKpiNames: string[]): boolean {
    const valuationOnly = /price_to_earnings|price_to_book|market_cap|ev_to_sales|ev_to_ebit/;
    const businessCount = selectedKpiNames.filter((name) => !valuationOnly.test(name)).length;
    return businessCount >= 2 && selectedKpiNames.length >= 3;
  }

  /**
   * Renders compact extracted-fact highlights so filing evidence contributes concrete signals instead of metadata-only labels.
   */
  private formatFilingFactHighlights(filing: FilingEntity): string {
    const priorityFacts = [
      "parse_mode",
      "parse_failure_reason",
      "contains_quantified_outlook",
      "mentions_risk_factor_change",
      "mentions_guidance_update",
      "mentions_margin_pressure",
      "mentions_demand_strength",
      "mentions_capex_increase",
      "mentions_buyback",
      "mentions_supply_constraint",
      "mentions_regulatory_action",
      "content_extraction_status",
    ];

    const highlighted = filing.extractedFacts
      .filter(
        (fact) =>
          priorityFacts.includes(fact.name) &&
          (fact.value === "true" ||
            fact.value === "false" ||
            fact.name === "content_extraction_status"),
      )
      .slice(0, 4)
      .map((fact) => `${fact.name}=${fact.value}`);

    return highlighted.length > 0 ? ` | facts: ${highlighted.join(", ")}` : "";
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

    const relevanceSelection = this.evidenceSelector.selectRelevantDocuments({
      docs,
      symbol: payload.symbol,
      identity: payload.resolvedIdentity,
      horizon: payload.horizonContext?.horizon ?? "1_2_quarters",
      selectedKpiNames:
        payload.kpiContext?.selected ?? payload.kpiContext?.required ?? [],
    });
    const selectedDocs = relevanceSelection.selected;
    await this.documentRepo.upsertMany(relevanceSelection.classifiedDocuments);

    const latestByMetricName = this.latestMetricByName(metrics);
    const latestMetrics = latestByMetricName
      .filter((metric) => !this.isMacroMetricName(metric.metricName))
      .slice(0, 8);
    const selectedMacroMetrics = this.selectMacroMetrics(
      latestByMetricName.filter((metric) =>
        this.isMacroMetricName(metric.metricName),
      ),
      payload.kpiContext?.template,
    );
    const promptMetrics = [...latestMetrics, ...selectedMacroMetrics];
    const sourceLines = selectedDocs
      .slice(0, 10)
      .map((doc) => {
        const label = relevanceSelection.newsLabelByDocumentId.get(doc.id);
        if (!label) {
          return null;
        }
        return `- ${label} ${doc.provider}: ${doc.title}`;
      })
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const metricLines = latestMetrics
      .map(
        (metric, index) =>
          `- M${index + 1} ${metric.provider}: ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""} (${metric.periodType}, as of ${metric.asOf.toISOString().slice(0, 10)})`,
      )
      .join("\n");
    const macroLines = selectedMacroMetrics
      .map(
        (metric, index) =>
          `- M${latestMetrics.length + index + 1} ${metric.provider}: ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""} (${metric.periodType}, as of ${metric.asOf.toISOString().slice(0, 10)})`,
      )
      .join("\n");

    const filingLines = filings
      .slice(0, 6)
      .map(
        (filing, index) =>
          `- F${index + 1} ${filing.provider}: ${filing.filingType} filed ${filing.filedAt.toISOString().slice(0, 10)}${filing.accessionNo ? ` accession ${filing.accessionNo}` : ""}${filing.docUrl ? ` (${filing.docUrl})` : ""}${this.formatFilingFactHighlights(filing)}`,
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
    const shouldForceIdentityUncertainty =
      this.evidenceSelector.shouldForceIdentityUncertainty(
        payload.resolvedIdentity,
        relevanceSelection,
      );
    const now = this.clock.now();
    const signalPack = this.normalizedSignalService.buildSignalPack({
      metrics,
      now,
      selectedKpiNames: payload.kpiContext?.selected ?? payload.kpiContext?.required ?? [],
    });
    const metricLabelByName = new Map<string, string>();
    latestMetrics.forEach((metric, index) => {
      metricLabelByName.set(metric.metricName, `M${index + 1}`);
    });
    selectedMacroMetrics.forEach((metric, index) => {
      metricLabelByName.set(
        metric.metricName,
        `M${latestMetrics.length + index + 1}`,
      );
    });
    const filingLabelByFactName = new Map<string, string>();
    filings.slice(0, 6).forEach((filing, index) => {
      const filingLabel = `F${index + 1}`;
      filing.extractedFacts.forEach((fact) => {
        if (!filingLabelByFactName.has(fact.name)) {
          filingLabelByFactName.set(fact.name, filingLabel);
        }
      });
    });
    const valuationView = this.deriveValuationView(latestMetrics);
    const derivedCatalysts = this.deriveCatalysts(selectedDocs, latestMetrics, filings);
    let actionMatrix = this.decisionPolicy.buildActionMatrix(
      signalPack,
      latestMetrics,
      filings,
      metricLabelByName,
      filingLabelByFactName,
    );
    let triggerInvariantViolations = this.decisionPolicy.validateTriggerRows(
      actionMatrix,
    );
    let fallbackTriggerSetApplied = false;
    if (triggerInvariantViolations.length > 0) {
      actionMatrix = this.decisionPolicy.buildFallbackTriggerRows({
        signalPack,
        metricLabelByName,
      });
      fallbackTriggerSetApplied = true;
      triggerInvariantViolations = this.decisionPolicy.validateTriggerRows(
        actionMatrix,
      );
    }
    const actionMatrixLines = this.decisionPolicy.formatActionMatrix(actionMatrix);
    const falsification = this.decisionPolicy.buildFalsification(actionMatrix);
    const fallbackSelectedKpiNames = latestMetrics
      .slice(0, 8)
      .map((metric) => metric.metricName);
    const kpiCoverage = await this.computeKpiCoverage({
      payload,
      now,
      fallbackSelectedKpiNames,
    });
    const sufficiencyDiagnostics = this.decisionPolicy.buildSufficiencyDiagnostics({
      selection: relevanceSelection,
      signalPack,
      kpiCoverage: kpiCoverage.diagnostics,
      filingsCount: filings.length,
      valuationAvailable: !valuationView.toLowerCase().includes("unavailable"),
      catalystsCount: derivedCatalysts.length,
      falsifiersCount: falsification.length,
    });
    const decisionResult = this.decisionPolicy.deriveDecisionFromSignals({
      signalPack,
      sufficiency: sufficiencyDiagnostics,
      selection: relevanceSelection,
      filings,
    });
    const rawActionDecision = this.decisionPolicy.toActionDecision(
      decisionResult.decision,
      sufficiencyDiagnostics,
      kpiCoverage.diagnostics,
    );
    const hasEnoughBusinessKpis = this.hasEnoughBusinessKpis(kpiCoverage.selectedCurrentKpiNames);
    const conservativeActionDecision =
      payload.thesisTypeContext?.thesisType === "unclear" ||
      (payload.thesisTypeContext?.confidence ?? 0) < 55 ||
      !hasEnoughBusinessKpis
        ? rawActionDecision === "avoid" ||
          rawActionDecision === "insufficient_evidence"
          ? rawActionDecision
          : "watch"
        : rawActionDecision;
    const evidenceWeak = !sufficiencyDiagnostics.passed;
    const insufficientEvidenceReasons =
      conservativeActionDecision === "insufficient_evidence"
        ? Array.from(
            new Set([
              ...sufficiencyDiagnostics.reasonCodes,
              ...sufficiencyDiagnostics.missingCriticalDimensions.map(
                (dimension) => `missing_${dimension}`,
              ),
            ]),
          ).slice(0, 8)
        : [];
    const decisionReasonLines =
      decisionResult.reasons.length > 0
        ? decisionResult.reasons.map((reason) => `- ${reason}`).join("\n")
        : "- none";
    const memoryResult = await this.fetchCrossRunMemory(
      payload,
      selectedDocs,
      promptMetrics,
      filings,
      now,
    );
    const memoryMatches = memoryResult.matches;
    const payloadWithMemoryDiagnostics = memoryResult.nextPayload;
    const memoryLines = this.promptBuilder.formatMemoryLines(memoryMatches);
    const evidenceMapLines = this.promptBuilder.buildEvidenceMapLines(
      selectedDocs,
      relevanceSelection.newsLabelByDocumentId,
      promptMetrics,
      filings,
      memoryMatches,
    );

    const prompt = this.promptBuilder.buildSynthesisPrompt({
      synthesisTarget,
      identityLines,
      metricsDiagnosticsLine,
      providerFailureLines,
      stageIssueLines,
      sourceLines,
      metricLines,
      macroLines,
      filingLines,
      memoryLines,
      actionMatrixLines,
      decisionFromContext: decisionResult.decision,
      decisionReasonLines,
      relevanceSelection,
      shouldForceIdentityUncertainty,
      evidenceWeak,
    });

    const thesisResult = await this.llm.synthesize(prompt);

    if (thesisResult.isErr()) {
      throw new Error(
        `Synthesis failed due to LLM error: ${thesisResult.error.message}`,
      );
    }

    let thesis = this.thesisGuard.upsertActionSummaryDeterminism(
      this.thesisGuard.upsertEvidenceMapSection(thesisResult.value, evidenceMapLines),
      decisionResult.decision,
      actionMatrix,
    );
    const hasEvidence = selectedDocs.length + promptMetrics.length + filings.length > 0;
    const initialValidationIssues = this.thesisGuard.validateThesis(
      thesis,
      hasEvidence,
      shouldForceIdentityUncertainty,
      evidenceWeak,
      memoryMatches.length,
    );
    let finalValidationIssues = initialValidationIssues;

    if (initialValidationIssues.length > 0) {
      const repairPrompt = this.promptBuilder.buildRepairPrompt(
        prompt,
        thesis,
        initialValidationIssues,
      );
      const repairedResult = await this.llm.synthesize(repairPrompt);
      if (repairedResult.isErr()) {
        throw new Error(
          `Synthesis repair failed due to LLM error: ${repairedResult.error.message}`,
        );
      }

      const repairedThesis = this.thesisGuard.upsertActionSummaryDeterminism(
        this.thesisGuard.upsertEvidenceMapSection(repairedResult.value, evidenceMapLines),
        decisionResult.decision,
        actionMatrix,
      );
      const repairedIssues = this.thesisGuard.validateThesis(
        repairedThesis,
        hasEvidence,
        shouldForceIdentityUncertainty,
        evidenceWeak,
        memoryMatches.length,
      );
      if (repairedIssues.length <= initialValidationIssues.length) {
        thesis = repairedThesis;
        finalValidationIssues = repairedIssues;
      }
    }

    let thesisQuality = this.thesisGuard.scoreThesisQuality(
      thesis,
      finalValidationIssues,
      hasEvidence,
    );
    let fallbackApplied = false;
    const fallbackTriggeredByScore = thesisQuality.score;
    if (fallbackTriggeredByScore < this.thesisQualityMinScore) {
      thesis = this.thesisGuard.buildDeterministicFallbackThesis({
        actionDecision: conservativeActionDecision,
        actionMatrix,
        evidenceMapLines,
        selectedDocs,
        metrics: promptMetrics,
        filings,
        relevanceSelection,
      });
      fallbackApplied = true;
      finalValidationIssues = this.thesisGuard.validateThesis(
        thesis,
        hasEvidence,
        shouldForceIdentityUncertainty,
        evidenceWeak,
        memoryMatches.length,
      );
      thesisQuality = this.thesisGuard.scoreThesisQuality(
        thesis,
        finalValidationIssues,
        hasEvidence,
      );
    }
    const fallbackReasonCodes = fallbackApplied
      ? [
          `thesis_quality_below_floor_${fallbackTriggeredByScore}_lt_${this.thesisQualityMinScore}`,
          ...thesisQuality.failedChecks.slice(0, 5),
        ]
      : [];

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
    thesis = this.thesisGuard.upsertFinalDecisionPresentation(
      thesis,
      fallbackApplied && conservativeActionDecision === "buy"
        ? "watch"
        : conservativeActionDecision,
      actionMatrix,
    );
    const finalActionDecision: ActionDecision =
      fallbackApplied && conservativeActionDecision === "buy"
        ? "watch"
        : conservativeActionDecision;
    const confidenceV2 = this.investorViewBuilder.buildConfidenceDecomposition({
      selectedDocs,
      metrics: latestMetrics,
      filings,
      now,
      relevanceCoverage,
      horizonScore: payload.horizonContext?.score ?? 55,
      sufficiencyDiagnostics,
      decisionScoreBreakdown: decisionResult.scoreBreakdown,
      fallbackApplied,
      issuerAnchorCount: relevanceSelection.issuerAnchorCount,
    });
    const citationDiagnostics = this.thesisGuard.computeCitationDiagnostics(thesis);
    const investorKpis = this.investorViewBuilder.buildInvestorKpis(
      kpiCoverage.selectedCurrentKpiNames,
      metricLabelByName,
      latestMetrics,
    );
    const investorCatalysts: InvestorCatalyst[] = derivedCatalysts.map((catalyst, index) => ({
      event: catalyst,
      window:
        (payload.horizonContext?.horizon ?? "1_2_quarters") === "0_4_weeks"
          ? "next 0-4 weeks"
          : (payload.horizonContext?.horizon ?? "1_2_quarters") === "1_3_years"
            ? "next 1-3 years"
            : "next 1-2 quarters",
      expectedDirection: "supports or weakens thesis depending on observed KPI trajectory",
      whyItMatters: "Catalyst determines whether current expectations need to be revised.",
      evidenceRefs: this.investorViewBuilder.resolveCatalystEvidenceRefs({
        index,
        selectedNewsLabels: relevanceSelection.selectedNewsLabels,
        metricCount: promptMetrics.length,
        filingCount: Math.min(6, filings.length),
      }),
    }));
    const investorDrivers: InvestorDriver[] = [
      {
        driver: "Revenue and demand durability",
        kpis: investorKpis.slice(0, 3).map((kpi) => kpi.name),
        evidenceRefs: ["M1", "F1"],
      },
      {
        driver: "Margin and valuation support",
        kpis: investorKpis.slice(2, 5).map((kpi) => kpi.name),
        evidenceRefs: ["M2", "M3"],
      },
    ].filter((driver) => driver.kpis.length > 0);

    const investorViewV2: InvestorViewV2 = {
      thesisType: payload.thesisTypeContext?.thesisType ?? "unclear",
      action: {
        decision: finalActionDecision,
        positionSizing:
          fallbackApplied && finalActionDecision === "watch"
            ? "small"
            : this.decisionPolicy.toPositionSizing(finalActionDecision),
      },
      horizon: {
        bucket: (payload.horizonContext?.horizon ?? "1_2_quarters") as HorizonBucket,
        rationale:
          payload.horizonContext?.rationale ??
          "Intermediate horizon selected because evidence strength is mixed.",
      },
      summary: {
        oneLineThesis:
          finalActionDecision === "insufficient_evidence"
            ? "Evidence is currently insufficient for a high-conviction directional call."
            : finalActionDecision === "watch"
              ? "Current evidence supports monitoring execution, not a high-conviction directional bet."
              : `Current evidence supports a ${finalActionDecision} stance on business execution over the selected horizon.`,
      },
      variantView: {
        pricedInNarrative:
          "Market appears priced for continuation of recent operating and valuation trajectory.",
        ourVariant:
          finalActionDecision === "insufficient_evidence"
            ? "Current evidence does not yet support a differentiated variant view."
            : "Expected outcome depends on whether key business KPIs hold through upcoming checkpoints.",
        whyMispriced:
          finalActionDecision === "insufficient_evidence"
            ? "Evidence quality and KPI depth remain too limited for a strong variant call."
            : "Current pricing may under/overweight durability of the most material business drivers.",
      },
      drivers: investorDrivers.slice(0, 4),
      keyKpis: investorKpis.slice(0, 10),
      catalysts: investorCatalysts.slice(0, 5),
      falsification: falsification.slice(0, 2),
      valuation: {
        valuationFramework: "multiples + growth durability + filing context",
        keyMultiples: latestMetrics
          .filter((metric) => /price_to_earnings|price_to_book|ev_to_sales|ev_to_ebit/.test(metric.metricName))
          .slice(0, 3)
          .map((metric) => `${metric.metricName}=${this.formatMetricValue(metric)}`),
        historyContext: "Interpreted against latest available run history only.",
        peerContext: "Peer-relative context inferred from available market-context metrics.",
        valuationView: valuationView.toLowerCase().includes("constructive")
          ? "cheap"
          : valuationView.toLowerCase().includes("cautious")
            ? "expensive"
            : valuationView.toLowerCase().includes("unavailable")
              ? "uncertain"
              : "fair",
      },
      confidence: confidenceV2,
    };

    await this.snapshotRepo.save({
      id: this.ids.next(),
      runId: payload.runId,
      taskId: payload.taskId,
      symbol: payload.symbol,
      horizon: payload.horizonContext?.horizon ?? "1_2_quarters",
      score,
      thesis,
      risks: this.deriveRisks(selectedDocs, latestMetrics, filings),
      catalysts: derivedCatalysts,
      valuationView,
      confidence,
      sources: this.uniqueSources(selectedDocs, promptMetrics, filings),
      investorViewV2,
      diagnostics: {
        metrics: payload.metricsDiagnostics,
        metricsCompanyFacts: payload.metricsCompanyFactsDiagnostics,
        providerFailures: payload.providerFailures,
        stageIssues: payloadWithMemoryDiagnostics.stageIssues,
        identity: payload.resolvedIdentity,
        newsQuality: {
          total: relevanceSelection.totalHeadlinesCount,
          issuerMatched: relevanceSelection.issuerMatchedHeadlinesCount,
          excluded: relevanceSelection.excludedHeadlinesCount,
          mode: this.relevanceMode,
          excludedReasonsSample:
            relevanceSelection.excludedHeadlineReasonSamples.slice(0, 8),
        },
        newsQualityV2: {
          totalConsidered: relevanceSelection.totalHeadlinesCount,
          included: relevanceSelection.selected.length,
          excluded: relevanceSelection.excludedHeadlinesCount,
          averageCompositeScore: relevanceSelection.averageCompositeScore,
          mode: "enforce",
          prefilterClassCountsBefore: relevanceSelection.prefilterClassCountsBefore,
          prefilterClassCountsAfter: relevanceSelection.prefilterClassCountsAfter,
          issuerAnchorAvailable: relevanceSelection.issuerAnchorAvailable,
          issuerAnchorAvailableCount: relevanceSelection.issuerAnchorAvailableCount,
          issuerAnchorSelectedCount: relevanceSelection.issuerAnchorCount,
          payloadOnlyRatio: relevanceSelection.payloadOnlyRecovery.payloadOnlyRatio,
          recoveryInvoked: relevanceSelection.payloadOnlyRecovery.recoveryInvoked,
          recoveryStatus: relevanceSelection.payloadOnlyRecovery.recoveryStatus,
          recoveryReason: relevanceSelection.payloadOnlyRecovery.recoveryReason,
          issuerAnchorAvailableBefore:
            relevanceSelection.payloadOnlyRecovery.issuerAnchorAvailableBefore,
          issuerAnchorAvailableAfter:
            relevanceSelection.payloadOnlyRecovery.issuerAnchorAvailableAfter,
          issuerAnchorSelectedBefore:
            relevanceSelection.payloadOnlyRecovery.issuerAnchorSelectedBefore,
          issuerAnchorSelectedAfter:
            relevanceSelection.payloadOnlyRecovery.issuerAnchorSelectedAfter,
          metricHeavyDueToNarrativeGap:
            relevanceSelection.payloadOnlyRecovery.metricHeavyDueToNarrativeGap,
          excludedByReason: relevanceSelection.excludedByReason,
          scoreBreakdownSample: relevanceSelection.scoreBreakdownSample.slice(0, 8),
        },
        readThroughQualityV2: {
          issuerIncluded: relevanceSelection.includedByClass.issuer,
          peerIncluded: relevanceSelection.includedByClass.peer,
          supplyChainIncluded: relevanceSelection.includedByClass.supply_chain,
          customerIncluded: relevanceSelection.includedByClass.customer,
          industryIncluded: relevanceSelection.includedByClass.industry,
          issuerAnchorPresent: relevanceSelection.issuerAnchorPresent,
          excludedByClass: relevanceSelection.excludedByClass,
          excludedByClassAndReason: relevanceSelection.excludedByClassAndReason,
        },
        issuerMatchDiagnostics: relevanceSelection.issuerMatchDiagnostics,
        macroContext: payload.macroContextDiagnostics
          ? {
              totalMetricCount: payload.macroContextDiagnostics.totalMetricCount,
              providers: payload.macroContextDiagnostics.providers,
              selectedForTemplate: selectedMacroMetrics.map(
                (metric) => metric.metricName,
              ),
            }
          : undefined,
        decisionReasons: decisionResult.reasons.slice(0, 8),
        thesisQuality: {
          score: thesisQuality.score,
          failedChecks: thesisQuality.failedChecks,
          fallbackApplied,
        },
        fallbackReasonCodes: fallbackReasonCodes.slice(0, 8),
        evidenceGate: {
          passed: sufficiencyDiagnostics.passed,
          failures: insufficiencyReasonsToFailures(insufficientEvidenceReasons),
          missingFields: sufficiencyDiagnostics.missingCriticalDimensions,
        },
        kpiCoverage: kpiCoverage.diagnostics,
        signalDiagnostics: signalPack,
        sufficiencyDiagnostics,
        decisionScoreBreakdown: decisionResult.scoreBreakdown,
        triggerDiagnostics: {
          compiledCount: actionMatrix.length,
          renderedCount: falsification.length,
          invariantViolations: triggerInvariantViolations,
          fallbackTriggerSetApplied,
        },
        insufficientEvidenceReasons,
        missingFields: sufficiencyDiagnostics.missingCriticalDimensions,
        citationCoveragePct: citationDiagnostics.citationCoveragePct,
        unlinkedClaimsCount: citationDiagnostics.unlinkedClaimsCount,
      },
      createdAt: now,
    });
  }
}

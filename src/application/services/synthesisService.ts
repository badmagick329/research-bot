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
  EvidenceGateDiagnostics,
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
  SnapshotProviderFailureDiagnostics,
  SnapshotStageDiagnostics,
} from "../../core/entities/research";
import {
  type NewsDocumentClass,
  type NewsScoredItem,
  scoreNewsCandidate,
} from "./newsScoringV2";

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
  condition: string;
  action: string;
  citations: string[];
  hasNumericThreshold: boolean;
};
type DecisionContext = {
  evidenceWeak: boolean;
  lowRelevance: boolean;
  valuationStress: boolean;
  growthStrength: boolean;
  filingRiskFlag: boolean;
  analystSupport: boolean;
  issuerAnchorCount: number;
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
   * Builds normalized issuer identity patterns so symbol/name/alias matching can gate headline inclusion deterministically.
   */
  private buildIssuerIdentityPatterns(
    symbol: string,
    identity: ResolvedCompanyIdentity | undefined,
  ): IssuerIdentityPatterns {
    const symbolExactTokens = new Set<string>();
    const symbolPhraseTokens = new Set<string>();
    const aliasExactTokens = new Set<string>();
    const aliasPhraseTokens = new Set<string>();
    const companyExactTokens = new Set<string>();
    const companyPhraseTokens = new Set<string>();
    const exactTokens = new Set<string>();
    const phraseTokens = new Set<string>();

    const addToken = (
      raw: string,
      exactBucket: Set<string>,
      phraseBucket: Set<string>,
    ) => {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) {
        return;
      }

      const punctuationStripped = normalized
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const noSuffix = punctuationStripped
        .replace(/\b(inc|incorporated|corp|corporation|co|company|plc|ltd|limited)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();

      [normalized, punctuationStripped, noSuffix].forEach((candidate) => {
        if (!candidate) {
          return;
        }
        if (/^[a-z0-9]{2,5}$/.test(candidate)) {
          exactTokens.add(candidate);
          exactBucket.add(candidate);
        } else {
          phraseTokens.add(candidate);
          phraseBucket.add(candidate);
        }
      });
    };

    addToken(symbol, symbolExactTokens, symbolPhraseTokens);
    if (identity) {
      addToken(
        identity.canonicalSymbol,
        symbolExactTokens,
        symbolPhraseTokens,
      );
      addToken(
        identity.requestedSymbol,
        symbolExactTokens,
        symbolPhraseTokens,
      );
      identity.aliases.forEach((alias) =>
        addToken(alias, aliasExactTokens, aliasPhraseTokens),
      );
      addToken(identity.companyName, companyExactTokens, companyPhraseTokens);
    }

    return {
      symbolExactTokens,
      symbolPhraseTokens,
      aliasExactTokens,
      aliasPhraseTokens,
      companyExactTokens,
      companyPhraseTokens,
      exactTokens,
      phraseTokens,
    };
  }

  /**
   * Enforces issuer identity gating so non-issuer headlines are excluded before relevance ranking.
   */
  private matchesIssuerIdentity(
    doc: DocumentEntity,
    patterns: IssuerIdentityPatterns,
  ): IssuerMatchResult {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const fields: Record<IssuerMatchField, string> = {
      title: normalize(doc.title),
      summary: normalize(doc.summary ?? ""),
      content: normalize(doc.content),
      payload: normalize(this.extractPayloadTickerHints(doc.rawPayload).join(" ")),
      alias: "",
      company: "",
    };

    const matchesTokenGroup = (
      fieldValue: string,
      exactGroup: Set<string>,
      phraseGroup: Set<string>,
    ): boolean => {
      if (!fieldValue) {
        return false;
      }

      for (const token of exactGroup) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(fieldValue)) {
          return true;
        }
      }

      for (const phrase of phraseGroup) {
        if (fieldValue.includes(phrase)) {
          return true;
        }
      }

      return false;
    };

    const matchedFields = new Set<IssuerMatchField>();
    let titleMatched = false;
    let summaryMatched = false;
    let contentMatched = false;
    let payloadMatched = false;
    (Object.entries(fields) as Array<[IssuerMatchField, string]>)
      .filter(([field]) => field === "title" || field === "summary" || field === "content" || field === "payload")
      .forEach(([field, fieldValue]) => {
        const tokenMatch = matchesTokenGroup(
          fieldValue,
          patterns.exactTokens,
          patterns.phraseTokens,
        );
        const aliasMatch = matchesTokenGroup(
          fieldValue,
          patterns.aliasExactTokens,
          patterns.aliasPhraseTokens,
        );
        const companyMatch = matchesTokenGroup(
          fieldValue,
          patterns.companyExactTokens,
          patterns.companyPhraseTokens,
        );
        if (tokenMatch || aliasMatch || companyMatch) {
          matchedFields.add(field);
          if (field === "title") {
            titleMatched = true;
          } else if (field === "summary") {
            summaryMatched = true;
          } else if (field === "content") {
            contentMatched = true;
          } else if (field === "payload") {
            payloadMatched = true;
          }
        }
        if (aliasMatch) {
          matchedFields.add("alias");
        }
        if (companyMatch) {
          matchedFields.add("company");
        }
      });
    const matchedFieldsList = Array.from(matchedFields);
    const fieldsMatched = matchedFieldsList.length;
    const narrativeMatch = titleMatched || summaryMatched || contentMatched;
    const payloadOnlyMatch = payloadMatched && !narrativeMatch;
    if (payloadOnlyMatch) {
      return {
        matched: false,
        fieldsMatched,
        matchedFields: matchedFieldsList,
        payloadOnlyMatch: true,
        reason: "payload_only_issuer_match",
      };
    }
    if (fieldsMatched >= this.issuerMatchMinFields && narrativeMatch) {
      return {
        matched: true,
        fieldsMatched,
        matchedFields: matchedFieldsList,
        payloadOnlyMatch: false,
      };
    }

    return {
      matched: false,
      fieldsMatched,
      matchedFields: matchedFieldsList,
      payloadOnlyMatch: false,
      reason: "no_issuer_identity_match",
    };
  }

  /**
   * Scores a headline for issuer relevance so synthesis evidence prioritizes company-specific context.
   */
  private scoreDocumentRelevance(
    doc: DocumentEntity,
    issuerTokens: string[],
    issuerMatched: boolean,
  ): RankedDocument {
    const title = doc.title.toLowerCase();
    const summary = (doc.summary ?? "").toLowerCase();
    const content = doc.content.toLowerCase();
    const payloadHints = this.extractPayloadTickerHints(doc.rawPayload);

    let score = 0;
    let issuerMentioned = false;

    issuerTokens.forEach((token) => {
      if (title.includes(token)) {
        score += 4;
        issuerMentioned = true;
      }

      if (summary.includes(token) || content.includes(token)) {
        score += 2;
        issuerMentioned = true;
      }

      if (payloadHints.includes(token)) {
        score += 3;
        issuerMentioned = true;
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
      "best stocks",
      "top stocks",
      "to watch",
      "market wrap",
      "broad market",
      "daily movers",
    ];

    noisyHeadlineTerms.forEach((term) => {
      if (title.includes(term)) {
        score -= 4;
      }
    });

    if (!doc.url || doc.url.trim().length === 0) {
      score -= 1;
    }

    if (!issuerMatched) {
      score -= 15;
    }

    if (this.relevanceMode === "high_precision" && !issuerMentioned) {
      score -= 8;
    }

    const minScore = this.relevanceMode === "high_precision" ? this.minRelevanceScore : 5;
    const isRelevant =
      score >= minScore &&
      (this.relevanceMode !== "high_precision" || issuerMentioned);
    return { doc, score, isRelevant };
  }

  /**
   * Selects the most issuer-relevant headlines and tracks coverage diagnostics for prompt guidance.
   */
  private selectRelevantDocuments(
    docs: DocumentEntity[],
    symbol: string,
    identity: ResolvedCompanyIdentity | undefined,
    horizon: HorizonBucket,
    kpiNames: string[],
  ): RelevanceSelection {
    const emptyPrefilterClassCounts: Record<NewsDocumentClass, number> = {
      issuer_news: 0,
      read_through_news: 0,
      market_context: 0,
      generic_market_noise: 0,
    };

    if (docs.length === 0) {
      return {
        selected: [],
        classifiedDocuments: [],
        selectedNewsLabels: [],
        newsLabelByDocumentId: new Map<string, string>(),
        issuerAnchorPresent: false,
        includedByClass: {
          issuer: 0,
          peer: 0,
          supply_chain: 0,
          customer: 0,
          industry: 0,
        },
        excludedByClass: {
          issuer: 0,
          peer: 0,
          supply_chain: 0,
          customer: 0,
          industry: 0,
        },
        excludedByClassAndReason: {},
        relevantHeadlinesCount: 0,
        selectedRelevantCount: 0,
        lowRelevance: true,
        totalHeadlinesCount: 0,
        issuerMatchedHeadlinesCount: 0,
        excludedHeadlinesCount: 0,
        excludedHeadlineReasons: [],
        excludedHeadlineReasonSamples: [],
        averageCompositeScore: 0,
        excludedByReason: {},
        issuerAnchorCount: 0,
        prefilterClassCountsBefore: { ...emptyPrefilterClassCounts },
        prefilterClassCountsAfter: { ...emptyPrefilterClassCounts },
        issuerAnchorAvailable: false,
        issuerAnchorAvailableCount: 0,
        issuerMatchDiagnostics: {
          title: 0,
          summary: 0,
          content: 0,
          payload: 0,
          payloadOnlyRejected: 0,
        },
        scoreBreakdownSample: [],
      };
    }

    const identityPatterns = this.buildIssuerIdentityPatterns(symbol, identity);
    const excludedHeadlineReasons: ExcludedHeadlineReason[] = [];
    const excludedHeadlineReasonSamples: string[] = [];
    const excludedByReason: Record<string, number> = {};
    const excludedByClass: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const includedByClass: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const excludedByClassAndReason: Record<string, Record<string, number>> = {};
    const prefilterClassCountsBefore: Record<NewsDocumentClass, number> = {
      ...emptyPrefilterClassCounts,
    };
    const prefilterClassCountsAfter: Record<NewsDocumentClass, number> = {
      ...emptyPrefilterClassCounts,
    };
    const issuerMatchDiagnostics = {
      title: 0,
      summary: 0,
      content: 0,
      payload: 0,
      payloadOnlyRejected: 0,
    };
    const seenTitle = new Set<string>();
    const seenUrl = new Set<string>();
    const scored: NewsScoredItem[] = [];
    docs.forEach((doc) => {
      const match = this.matchesIssuerIdentity(doc, identityPatterns);
      if (match.matchedFields.includes("title")) {
        issuerMatchDiagnostics.title += 1;
      }
      if (match.matchedFields.includes("summary")) {
        issuerMatchDiagnostics.summary += 1;
      }
      if (match.matchedFields.includes("content")) {
        issuerMatchDiagnostics.content += 1;
      }
      if (match.matchedFields.includes("payload")) {
        issuerMatchDiagnostics.payload += 1;
      }
      if (match.payloadOnlyMatch) {
        issuerMatchDiagnostics.payloadOnlyRejected += 1;
      }
      const scoredItem = scoreNewsCandidate(
        {
          doc,
          issuerMatched: match.matched,
          payloadOnlyIssuerMatch: match.payloadOnlyMatch,
          horizon,
          kpiNames,
          seenTitleKeys: seenTitle,
          seenUrlKeys: seenUrl,
          sourceQualityMode: this.newsV2SourceQualityMode,
        },
        {
          minCompositeScore: this.newsV2MinCompositeScore,
          minMaterialityScore: this.newsV2MinMaterialityScore,
          minKpiLinkageScore: this.newsV2MinKpiLinkageScore,
          sourceQualityMode: this.newsV2SourceQualityMode,
        },
      );
      scored.push(scoredItem);
      prefilterClassCountsBefore[scoredItem.documentClass] += 1;
      if (scoredItem.urlKey) {
        seenUrl.add(scoredItem.urlKey);
      }
      if (scoredItem.titleKey) {
        seenTitle.add(scoredItem.titleKey);
      }
    });

    const rankingEligible = scored.filter((item) => item.includedByThresholds);
    rankingEligible.forEach((item) => {
      prefilterClassCountsAfter[item.documentClass] += 1;
    });
    const issuerAnchorCandidates = rankingEligible.filter(
      (item) => item.evidenceClass === "issuer",
    );
    const issuerAnchorAvailable = issuerAnchorCandidates.length > 0;
    const maxNonIssuerItems = Math.floor(this.newsV2MaxItems * 0.4);
    let selectedNonIssuerCount = 0;
    const sortedCandidates = [...scored].sort((left, right) => {
      if (right.composite !== left.composite) {
        return right.composite - left.composite;
      }
      const classOrderDelta =
        evidenceClassSortOrder[left.evidenceClass] -
        evidenceClassSortOrder[right.evidenceClass];
      if (classOrderDelta !== 0) {
        return classOrderDelta;
      }
      return right.doc.publishedAt.getTime() - left.doc.publishedAt.getTime();
    });

    const evaluatedCandidates = sortedCandidates.map((item) => ({
      ...item,
      includedFinal: false,
      exclusionReason: item.exclusionReason as ExcludedHeadlineReason | undefined,
    }));
    const evaluatedById = new Map(
      evaluatedCandidates.map((item) => [item.doc.id, item]),
    );
    const selectedDocumentIds = new Set<string>();
    const excludedDocumentIds = new Set<string>();
    const selectedProviders = new Set<string>();

    const applySelection = (item: NewsScoredItem) => {
      if (selectedDocumentIds.has(item.doc.id)) {
        return;
      }
      const evaluated = evaluatedById.get(item.doc.id);
      if (!evaluated) {
        return;
      }
      evaluated.includedFinal = true;
      evaluated.exclusionReason = undefined;
      selectedDocumentIds.add(item.doc.id);
      selectedProviders.add(item.doc.provider.toLowerCase());
      includedByClass[item.evidenceClass] += 1;
      if (item.evidenceClass !== "issuer") {
        selectedNonIssuerCount += 1;
      }
    };

    const applyExclusion = (
      item: NewsScoredItem,
      reason: ExcludedHeadlineReason,
    ) => {
      const evaluated = evaluatedById.get(item.doc.id);
      if (!evaluated || evaluated.includedFinal) {
        return;
      }
      evaluated.exclusionReason = reason;
      excludedDocumentIds.add(item.doc.id);
    };

    if (issuerAnchorAvailable) {
      const bestIssuerAnchor = sortedCandidates.find(
        (item) => item.includedByThresholds && item.evidenceClass === "issuer",
      );
      if (bestIssuerAnchor) {
        applySelection(bestIssuerAnchor);
      }
    }

    while (selectedDocumentIds.size < this.newsV2MaxItems) {
      const remaining = sortedCandidates.filter(
        (item) =>
          !selectedDocumentIds.has(item.doc.id) &&
          !excludedDocumentIds.has(item.doc.id),
      );
      if (remaining.length === 0) {
        break;
      }

      const rankedRemaining = remaining
        .map((item) => {
          let adjustedScore = item.composite;
          const providerKey = item.doc.provider.toLowerCase();
          if (!selectedProviders.has(providerKey)) {
            adjustedScore += 4;
          }
          if (includedByClass[item.evidenceClass] === 0) {
            adjustedScore += 3;
          }
          if (item.evidenceClass === "issuer" && includedByClass.issuer === 0) {
            adjustedScore += 8;
          }
          return { item, adjustedScore };
        })
        .sort((left, right) => {
          if (right.adjustedScore !== left.adjustedScore) {
            return right.adjustedScore - left.adjustedScore;
          }
          return (
            right.item.doc.publishedAt.getTime() - left.item.doc.publishedAt.getTime()
          );
        });
      const next = rankedRemaining.at(0)?.item;
      if (!next) {
        break;
      }

      if (!next.includedByThresholds) {
        applyExclusion(
          next,
          (next.exclusionReason ?? "below_composite_threshold") as ExcludedHeadlineReason,
        );
        continue;
      }

      const isReadThrough = next.evidenceClass !== "issuer";
      if (isReadThrough && !issuerAnchorAvailable) {
        applyExclusion(next, "read_through_without_issuer_anchor");
        continue;
      }
      if (isReadThrough && includedByClass.issuer === 0) {
        applyExclusion(next, "read_through_without_issuer_anchor");
        continue;
      }
      if (isReadThrough && selectedNonIssuerCount >= maxNonIssuerItems) {
        applyExclusion(next, "read_through_capped");
        continue;
      }

      applySelection(next);
    }

    evaluatedCandidates
      .filter((item) => !item.includedFinal && !item.exclusionReason)
      .forEach((item) => {
        item.exclusionReason = "below_composite_threshold";
      });

    const selectedRanked = evaluatedCandidates.filter((item) => item.includedFinal);
    selectedRanked.forEach((item) => {
      const nextDoc = item.doc;
      nextDoc.evidenceClass = item.evidenceClass;
    });

    const classCounters: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const newsLabelByDocumentId = new Map<string, string>();
    selectedRanked.forEach((item) => {
      classCounters[item.evidenceClass] += 1;
      newsLabelByDocumentId.set(
        item.doc.id,
        `N_${item.evidenceClass}${classCounters[item.evidenceClass]}`,
      );
    });

    evaluatedCandidates
      .filter((item) => !item.includedFinal)
      .forEach((item) => {
        const reason = item.exclusionReason ?? "below_composite_threshold";
        excludedHeadlineReasons.push(reason);
        excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
        excludedByClass[item.evidenceClass] += 1;
        if (!excludedByClassAndReason[item.evidenceClass]) {
          excludedByClassAndReason[item.evidenceClass] = {};
        }
        const classReasonCounts = excludedByClassAndReason[item.evidenceClass];
        if (!classReasonCounts) {
          return;
        }
        classReasonCounts[reason] = (classReasonCounts[reason] ?? 0) + 1;
        if (excludedHeadlineReasonSamples.length < 8) {
          excludedHeadlineReasonSamples.push(
            `${item.doc.title.slice(0, 96)} (${item.evidenceClass}; ${reason}; composite=${item.composite})`,
          );
        }
      });

    const relevant = selectedRanked;
    const selectedRelevantCount = selectedRanked.length;
    const lowRelevance =
      selectedRanked.length === 0 ||
      selectedRelevantCount < 3 ||
      selectedRelevantCount / Math.max(1, selectedRanked.length) < 0.5;
    const averageCompositeScore =
      evaluatedCandidates.length === 0
        ? 0
        : Number.parseFloat(
            (
              evaluatedCandidates.reduce((sum, item) => sum + item.composite, 0) /
              evaluatedCandidates.length
            ).toFixed(2),
          );
    const scoreBreakdownSample = evaluatedCandidates.slice(0, 8).map((item) => ({
      title: item.doc.title,
      composite: item.composite,
      components: item.components,
      included: item.includedFinal,
      reason: item.includedFinal ? undefined : item.exclusionReason,
      documentClass: item.documentClass,
      confidenceBand: item.confidenceBand,
    }));

    return {
      selected: selectedRanked.map((item) => ({
        ...item.doc,
        evidenceClass: item.evidenceClass,
      })),
      classifiedDocuments: evaluatedCandidates.map((item) => ({
        ...item.doc,
        evidenceClass: item.evidenceClass,
      })),
      selectedNewsLabels: selectedRanked
        .map((item) => newsLabelByDocumentId.get(item.doc.id))
        .filter((label): label is string => Boolean(label)),
      newsLabelByDocumentId,
      issuerAnchorPresent: includedByClass.issuer > 0,
      includedByClass,
      excludedByClass,
      excludedByClassAndReason,
      relevantHeadlinesCount: relevant.length,
      selectedRelevantCount,
      lowRelevance,
      totalHeadlinesCount: docs.length,
      issuerMatchedHeadlinesCount: scored.filter(
        (item) => item.evidenceClass === "issuer",
      ).length,
      excludedHeadlinesCount: docs.length - selectedRanked.length,
      excludedHeadlineReasons,
      excludedHeadlineReasonSamples,
      averageCompositeScore,
      excludedByReason,
      issuerAnchorCount: includedByClass.issuer,
      prefilterClassCountsBefore,
      prefilterClassCountsAfter,
      issuerAnchorAvailable,
      issuerAnchorAvailableCount: issuerAnchorCandidates.length,
      issuerMatchDiagnostics,
      scoreBreakdownSample,
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
   * Appends stage degradation diagnostics to snapshot payload state from within synthesis-time fallback paths.
   */
  private withStageIssue(
    payload: JobPayload,
    issue: SnapshotStageDiagnostics,
  ): JobPayload {
    return {
      ...payload,
      stageIssues: [...(payload.stageIssues ?? []), issue],
    };
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
        nextPayload: this.withStageIssue(payload, {
          stage: "embed",
          status: "degraded",
          reason: `Cross-run memory degraded due to ${queryEmbeddingResult.error.provider}: ${queryEmbeddingResult.error.message}`,
          provider: queryEmbeddingResult.error.provider,
          code: queryEmbeddingResult.error.code,
          retryable: queryEmbeddingResult.error.retryable,
        }),
      };
    }

    const queryEmbedding = queryEmbeddingResult.value.at(0);
    if (!queryEmbedding) {
      return {
        matches: [],
        nextPayload: this.withStageIssue(payload, {
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
        nextPayload: this.withStageIssue(payload, {
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
   * Converts evidence coverage quality into a simple weak/strong flag so synthesis can default to non-directional decisions.
   */
  private isEvidenceWeak(
    selection: RelevanceSelection,
    metricsCount: number,
    filingsCount: number,
  ): boolean {
    void filingsCount;
    return (
      selection.lowRelevance ||
      selection.selectedRelevantCount < 3 ||
      metricsCount < 3
    );
  }

  /**
   * Derives deterministic decision context flags so non-Watch outcomes can be reached only when objective evidence gates pass.
   */
  private buildDecisionContext(
    selection: RelevanceSelection,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
  ): DecisionContext {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const pe = byName.get("price_to_earnings")?.metricValue;
    const growthRatio = byName.get("revenue_growth_yoy")?.metricValue;
    const analystSupport = (byName.get("analyst_buy_ratio")?.metricValue ?? 0) >= 0.55;

    const filingRiskFlag = filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) =>
          (fact.name === "mentions_risk_factor_change" ||
            fact.name === "mentions_regulatory_action") &&
          fact.value === "true",
      ),
    );

    return {
      evidenceWeak: this.isEvidenceWeak(selection, metrics.length, filings.length),
      lowRelevance: selection.lowRelevance,
      valuationStress: typeof pe === "number" && pe >= 45,
      growthStrength: typeof growthRatio === "number" && growthRatio >= 0.15,
      filingRiskFlag,
      analystSupport,
      issuerAnchorCount: selection.issuerAnchorCount,
    };
  }

  /**
   * Applies deterministic policy gates for Buy/Watch/Avoid so final stance is auditable and less dependent on LLM phrasing.
   */
  private deriveDecisionFromContext(
    context: DecisionContext,
  ): { decision: ThesisDecision; reasons: string[] } {
    const reasons: string[] = [];

    if (context.filingRiskFlag && context.valuationStress) {
      reasons.push("high_valuation_with_filing_risk");
      return { decision: "avoid", reasons };
    }

    if (!context.evidenceWeak && !context.valuationStress && context.growthStrength) {
      if (context.issuerAnchorCount < 2) {
        reasons.push("insufficient_issuer_anchors");
        return { decision: "watch", reasons };
      }
      reasons.push("strong_growth_with_acceptable_valuation");
      if (context.analystSupport) {
        reasons.push("analyst_supportive");
      }
      return { decision: "buy", reasons };
    }

    reasons.push("conservative_default_watch");
    if (context.evidenceWeak) {
      reasons.push("evidence_weak");
    }
    if (context.valuationStress) {
      reasons.push("valuation_stress");
    }

    return { decision: "watch", reasons };
  }

  /**
   * Builds deterministic action triggers from concrete metrics/facts so If/Then guidance remains executable and non-generic.
   */
  private buildActionMatrix(
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    metricLabelByName: Map<string, string>,
    filingLabelByFactName: Map<string, string>,
  ): ActionMatrixRow[] {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    const rows: ActionMatrixRow[] = [];
    const metricCitation = (metricName: string): string[] => {
      const label = metricLabelByName.get(metricName);
      return label ? [label] : [];
    };
    const filingCitation = (factName: string): string[] => {
      const label = filingLabelByFactName.get(factName);
      return label ? [label] : [];
    };

    const pe = byName.get("price_to_earnings");
    if (pe) {
      rows.push({
        signalId: "valuation_pe",
        label: "Valuation multiple pressure",
        currentValue: `${this.formatMetricValue(pe)}${pe.metricUnit ? ` ${pe.metricUnit}` : ""}`,
        condition: `If P/E falls below 35 or earnings growth re-accelerates above 20%`,
        action: "then upgrade one notch",
        citations: metricCitation("price_to_earnings"),
        hasNumericThreshold: true,
      });
    }

    const growth = byName.get("revenue_growth_yoy");
    if (growth) {
      rows.push({
        signalId: "growth_revenue",
        label: "Top-line momentum",
        currentValue: `${(growth.metricValue * 100).toFixed(1)}%`,
        condition: "If revenue growth stays above 15% for next two quarters",
        action: "then add on strength",
        citations: metricCitation("revenue_growth_yoy"),
        hasNumericThreshold: true,
      });
    }

    const peerPePremium = byName.get("peer_pe_premium_pct");
    if (peerPePremium) {
      rows.push({
        signalId: "valuation_peer_premium",
        label: "Peer valuation premium",
        currentValue: `${peerPePremium.metricValue.toFixed(1)}%`,
        condition: "If peer P/E premium compresses below 10%",
        action: "then add selectively",
        citations: metricCitation("peer_pe_premium_pct"),
        hasNumericThreshold: true,
      });
    }

    const analyst = byName.get("analyst_buy_ratio");
    if (analyst) {
      rows.push({
        signalId: "analyst_support",
        label: "Analyst stance",
        currentValue: `${(analyst.metricValue * 100).toFixed(1)}% buy`,
        condition: "If analyst buy ratio drops below 45%",
        action: "then downgrade one notch",
        citations: metricCitation("analyst_buy_ratio"),
        hasNumericThreshold: true,
      });
    }

    const nextEarnings = byName.get("earnings_event_days_to_next");
    if (nextEarnings) {
      rows.push({
        signalId: "earnings_timing",
        label: "Event timing risk",
        currentValue: `${Math.round(nextEarnings.metricValue)} days`,
        condition: "If next earnings are within 10 days and valuation remains above 45x",
        action: "then hold size constant",
        citations: metricCitation("earnings_event_days_to_next"),
        hasNumericThreshold: true,
      });
    }

    const return3m = byName.get("price_return_3m");
    const volRegime = byName.get("volatility_regime_score");
    if (return3m && volRegime) {
      rows.push({
        signalId: "price_momentum_volatility",
        label: "Momentum versus volatility regime",
        currentValue: `3m return=${return3m.metricValue.toFixed(1)}%, volScore=${volRegime.metricValue.toFixed(1)}`,
        condition: "If 3m return stays above 15% while volatility regime score stays below 45",
        action: "then add on pullbacks",
        citations: [
          ...metricCitation("price_return_3m"),
          ...metricCitation("volatility_regime_score"),
        ],
        hasNumericThreshold: true,
      });
    }

    const filingRisk = filings.some((filing) =>
      filing.extractedFacts.some(
        (fact) => fact.name === "mentions_regulatory_action" && fact.value === "true",
      ),
    );
    rows.push({
      signalId: "filing_risk",
      label: "Regulatory risk signal",
      currentValue: filingRisk ? "true" : "false",
      condition: "If filing risk signals turn true in next disclosure",
      action: "then reduce risk exposure",
      citations: filingCitation("mentions_regulatory_action"),
      hasNumericThreshold: true,
    });

    const filtered = rows
      .map((row) => ({
        ...row,
        citations: row.citations.length > 0 ? row.citations : ["M1"],
      }))
      .slice(0, 5);
    const numericCount = filtered.filter((row) => row.hasNumericThreshold).length;
    if (numericCount < this.thesisTriggerMinNumeric) {
      filtered.push({
        signalId: "insufficient_signal",
        label: "Insufficient numeric signal coverage",
        currentValue: `${numericCount} numeric triggers`,
        condition: `If at least ${this.thesisTriggerMinNumeric} numeric triggers become available`,
        action: "then re-evaluate decision confidence",
        citations: ["M1"],
        hasNumericThreshold: true,
      });
    }

    while (filtered.length < 3) {
      const idx = filtered.length + 1;
      filtered.push({
        signalId: `coverage_fallback_${idx}`,
        label: "Coverage completion trigger",
        currentValue: `${metrics.length} metrics / ${filings.length} filings`,
        condition: `If available metric count reaches ${this.thesisTriggerMinNumeric + 2}`,
        action: "then upgrade confidence one step",
        citations: ["M1"],
        hasNumericThreshold: true,
      });
    }

    return filtered.slice(0, 5);
  }

  /**
   * Renders deterministic action matrix rows for prompt constraints and post-processing merges.
   */
  private formatActionMatrix(rows: ActionMatrixRow[]): string {
    return rows
      .map(
        (row, index) =>
          `- T${index + 1} ${row.label}: current=${row.currentValue}; ${row.condition}, ${row.action} (${row.citations.join(", ")})`,
      )
      .join("\n");
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
    macroLines: string;
    filingLines: string;
    memoryLines: string;
    actionMatrixLines: string;
    decisionFromContext: ThesisDecision;
    decisionReasonLines: string;
    relevanceSelection: RelevanceSelection;
    shouldForceIdentityUncertainty: boolean;
    evidenceWeak: boolean;
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
      "Cite each major claim with one or more evidence labels (N_<class>#, M#, F#).",
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
      `- evidenceWeak=${args.evidenceWeak}`,
      `- totalHeadlines=${args.relevanceSelection.totalHeadlinesCount}`,
      `- issuerMatchedHeadlines=${args.relevanceSelection.issuerMatchedHeadlinesCount}`,
      `- excludedHeadlines=${args.relevanceSelection.excludedHeadlinesCount}`,
      `- includedHeadlines=${args.relevanceSelection.selected.length}`,
      `- averageCompositeScore=${args.relevanceSelection.averageCompositeScore}`,
      `- prefilterClassCountsBefore=${Object.entries(args.relevanceSelection.prefilterClassCountsBefore)
        .map(([name, count]) => `${name}:${count}`)
        .join(",")}`,
      `- prefilterClassCountsAfter=${Object.entries(args.relevanceSelection.prefilterClassCountsAfter)
        .map(([name, count]) => `${name}:${count}`)
        .join(",")}`,
      `- issuerAnchorAvailable=${args.relevanceSelection.issuerAnchorAvailable}`,
      `- issuerAnchorAvailableCount=${args.relevanceSelection.issuerAnchorAvailableCount}`,
      `- issuerAnchorSelectedCount=${args.relevanceSelection.issuerAnchorCount}`,
      Object.keys(args.relevanceSelection.excludedByReason).length > 0
        ? `- excludedByReason=${Object.entries(args.relevanceSelection.excludedByReason)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(",")}`
        : "- excludedByReason=none",
      args.relevanceSelection.excludedHeadlineReasonSamples.length > 0
        ? `- excludedSample=${args.relevanceSelection.excludedHeadlineReasonSamples.join(" | ")}`
        : "- excludedSample=none",
      args.relevanceSelection.excludedHeadlineReasons.length > 0
        ? `- excludedReasons=${args.relevanceSelection.excludedHeadlineReasons.slice(0, 8).join(",")}`
        : "- excludedReasons=none",
      "",
      "News headlines:",
      args.sourceLines || "- none",
      "",
      "Market metrics:",
      args.metricLines || "- none",
      "",
      "Macro context (sector-sensitive):",
      args.macroLines || "- none",
      "",
      "Regulatory filings:",
      args.filingLines || "- none",
      "",
      "Cross-run memory (semantic matches, prior runs):",
      args.memoryLines,
      "",
      "Deterministic action matrix seed (must be preserved in If/Then triggers):",
      args.actionMatrixLines,
      "",
      "Deterministic decision seed:",
      `- decision=${args.decisionFromContext}`,
      args.decisionReasonLines,
      "",
      "Output requirements:",
      "- Return Markdown with headings in this order: Action Summary, Overview, Shareholder/Institutional Dynamics, Valuation and Growth Interpretation, Regulatory Filings, Missing Evidence, Conclusion.",
      "- Under # Action Summary, include exactly these labeled bullets:",
      "  - Decision: Buy|Watch|Avoid|Watch (Low Quality)|Insufficient Evidence",
      "  - Timeframe fit: Short-term (0-3m) ... ; Long-term (12m+) ...",
      "  - Reasons to invest:",
      "  - Reasons to stay away:",
      "  - If/Then triggers:",
      "  - Thesis invalidation:",
      "- Under Reasons to invest and Reasons to stay away, add 2-3 supporting sub-bullets each with citations.",
      "- Under If/Then triggers, add 3-5 sub-bullets in 'If ... then ...' form using numeric thresholds or filing booleans only.",
      "- Under Thesis invalidation, add 2-3 sub-bullets describing clear thesis break conditions.",
      "- Decision and each If/Then trigger must include at least one citation when evidence exists.",
      "- Do not include uncited claims in any section when evidence labels are available.",
      "- Decision should default to deterministic seed decision unless evidence in this run clearly contradicts it.",
      "- Avoid generic trigger language such as 'watch for', 'monitor', 'could', or 'may'.",
      "- If evidenceWeak=true, default Decision to Watch unless evidence strongly contradicts that default.",
      "- Use R# memory references only as supporting context, not as sole support for directional decisions when current-run evidence exists.",
      "- If memory conflicts with current-run evidence, explicitly call out the conflict in Missing Evidence.",
      "- For each section, tie claims to one or more evidence items (N_<class>#, M#, F# labels).",
      "- Explain what changed in shareholder/institutional dynamics.",
      "- Connect valuation or growth interpretation to provided metrics when available.",
      "- Use filings to support or challenge narrative when available.",
      "- Keep Overview/Valuation/Regulatory/Missing Evidence/Conclusion consistent with Action Summary.",
      "- In Conclusion, reaffirm Decision or explicitly explain any downgrade caused by evidence gaps.",
      "- Use only deterministic matrix trigger concepts for If/Then; do not invent new trigger families.",
      "- When a signal is missing, explicitly say which metric/fact is missing.",
      "- Explicitly state missing evidence if a section is empty.",
      "- If metrics diagnostics indicate missing or degraded metrics, mention that limitation in Missing Evidence.",
      "- If provider failures or pipeline stage issues are present, call them out explicitly in Missing Evidence.",
      "- If lowRelevance=true, explicitly state that weak issuer-specific headline relevance limits confidence.",
      "- If excludedHeadlines is high versus issuerMatchedHeadlines, explicitly mention noise pressure in Missing Evidence.",
      "- Treat listed aliases as the same issuer unless evidence explicitly contradicts this.",
      args.shouldForceIdentityUncertainty
        ? "- Explicitly mention identity uncertainty in Missing Evidence."
        : "- Never describe the symbol as a placeholder or unknown identifier.",
    ].join("\n");
  }

  /**
   * Builds a compact label map so citation tokens remain human-traceable in rendered thesis output.
   */
  private buildEvidenceMapLines(
    docs: DocumentEntity[],
    newsLabelByDocumentId: Map<string, string>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    memoryMatches: EmbeddingMemoryMatch[],
  ): string {
    const lines: string[] = [];

    docs.slice(0, 10).forEach((doc) => {
      const label = newsLabelByDocumentId.get(doc.id);
      if (!label) {
        return;
      }
      lines.push(`- ${label}: news "${doc.title}"`);
    });
    metrics.slice(0, 12).forEach((metric, index) => {
      lines.push(
        `- M${index + 1}: metric ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""}`,
      );
    });
    filings.slice(0, 6).forEach((filing, index) => {
      lines.push(
        `- F${index + 1}: filing ${filing.filingType} ${filing.filedAt.toISOString().slice(0, 10)}`,
      );
    });
    memoryMatches.slice(0, 6).forEach((match, index) => {
      lines.push(
        `- R${index + 1}: prior-run memory similarity=${match.similarity.toFixed(3)} date=${match.createdAt.toISOString().slice(0, 10)}`,
      );
    });

    return lines.length > 0 ? lines.join("\n") : "- none";
  }

  /**
   * Rewrites Evidence Map deterministically so citation-label mapping is owned by code, not LLM output variance.
   */
  private upsertEvidenceMapSection(thesis: string, evidenceMapLines: string): string {
    const evidenceMapSection = `# Evidence Map\n\n${evidenceMapLines}`;
    const sections = thesis
      .trim()
      .split(/\n(?=# )/g)
      .map((section) => section.trim())
      .filter(Boolean);

    const filteredSections = sections.filter(
      (section) => !section.toLowerCase().startsWith("# evidence map"),
    );

    const mergedSections: string[] = [];
    let inserted = false;

    filteredSections.forEach((section) => {
      if (!inserted && section.toLowerCase().startsWith("# overview")) {
        mergedSections.push(evidenceMapSection);
        inserted = true;
      }
      mergedSections.push(section);
    });

    if (!inserted) {
      const actionSummaryIndex = mergedSections.findIndex((section) =>
        section.toLowerCase().startsWith("# action summary"),
      );
      if (actionSummaryIndex >= 0) {
        mergedSections.splice(actionSummaryIndex + 1, 0, evidenceMapSection);
      } else {
        mergedSections.unshift(evidenceMapSection);
      }
    }

    return mergedSections.join("\n\n").trim();
  }

  /**
   * Rewrites Action Summary decision and trigger block from deterministic policy/matrix to keep final output actionable and auditable.
   */
  private upsertActionSummaryDeterminism(
    thesis: string,
    decision: ThesisDecision,
    actionMatrix: ActionMatrixRow[],
  ): string {
    const section = this.extractHeadingSection(thesis, "Action Summary");
    if (!section) {
      return thesis;
    }

    const decisionLabel = decision.charAt(0).toUpperCase() + decision.slice(1);
    const firstCitation = actionMatrix.flatMap((row) => row.citations).at(0) ?? "M1";
    const decisionLine = `- Decision: ${decisionLabel} [${firstCitation}]`;
    const triggerLines = actionMatrix
      .slice(0, 5)
      .map((row) => `  - If ${row.condition.replace(/^If\s+/i, "")}, ${row.action} [${row.citations.join("] [")}]`)
      .join("\n");

    const lines = section.split("\n");
    const rebuilt: string[] = [];
    let decisionInjected = false;
    let triggerInjected = false;
    let skippingTriggerBody = false;
    const labelRegex =
      /^(?:-\s*)?(?:\*\*)?(Reasons to invest:|Reasons to stay away:|If\/Then triggers:|Thesis invalidation:)(?:\*\*)?/i;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const labelMatch = line.match(labelRegex);
      if (labelMatch) {
        const label = (labelMatch[1] ?? "").toLowerCase();

        if (label.includes("if/then triggers")) {
          rebuilt.push("- If/Then triggers:");
          rebuilt.push(triggerLines);
          triggerInjected = true;
          skippingTriggerBody = true;
          continue;
        }

        skippingTriggerBody = false;
      }

      if (skippingTriggerBody) {
        if (labelRegex.test(line)) {
          skippingTriggerBody = false;
        } else {
          continue;
        }
      }

      if (/^-?\s*\*{0,2}decision\*{0,2}:/i.test(line)) {
        rebuilt.push(decisionLine);
        decisionInjected = true;
        continue;
      }

      rebuilt.push(rawLine);
    }

    if (!decisionInjected) {
      rebuilt.splice(0, 0, decisionLine);
    }
    if (!triggerInjected) {
      const idx = rebuilt.findIndex((line) =>
        /thesis invalidation:/i.test(line),
      );
      if (idx >= 0) {
        rebuilt.splice(idx, 0, "- If/Then triggers:", triggerLines);
      } else {
        rebuilt.push("- If/Then triggers:", triggerLines);
      }
    }

    const updatedSection = rebuilt.join("\n");

    return thesis.replace(
      /# Action Summary\n[\s\S]*?(?=\n# |\s*$)/i,
      `# Action Summary\n${updatedSection}\n`,
    );
  }

  /**
   * Aligns thesis markdown decision wording with final investor-facing action so UI/CLI narrative cannot drift from policy output.
   */
  private upsertFinalDecisionPresentation(
    thesis: string,
    decision: ActionDecision,
    actionMatrix: ActionMatrixRow[],
  ): string {
    const firstCitation = actionMatrix.flatMap((row) => row.citations).at(0) ?? "M1";
    const decisionLabel =
      decision === "buy"
        ? "Buy"
        : decision === "avoid"
          ? "Avoid"
          : decision === "watch_low_quality"
            ? "Watch (Low Quality)"
            : decision === "insufficient_evidence"
              ? "Insufficient Evidence"
              : "Watch";
    const decisionLine = `- Decision: ${decisionLabel} [${firstCitation}]`;

    const section = this.extractHeadingSection(thesis, "Action Summary");
    if (!section) {
      return thesis;
    }

    const updatedSection = section
      .split("\n")
      .map((line) =>
        /^-?\s*\*{0,2}decision\*{0,2}:/i.test(line.trim()) ? decisionLine : line,
      )
      .join("\n");

    let rewritten = thesis.replace(
      /# Action Summary\n[\s\S]*?(?=\n# |\s*$)/i,
      `# Action Summary\n${updatedSection}\n`,
    );

    if (/^# Conclusion[\s\S]*$/im.test(rewritten)) {
      rewritten = rewritten.replace(
        /(Decision remains )(Buy|Watch|Avoid|Watch \(Low Quality\)|Insufficient Evidence)(\b)/i,
        `$1${decisionLabel}$3`,
      );
    }

    return rewritten;
  }

  /**
   * Validates synthesis output structure and citation density so weak drafts can be repaired before persistence.
   */
  private validateThesis(
    thesis: string,
    hasEvidence: boolean,
    shouldForceIdentityUncertainty: boolean,
    evidenceWeak: boolean,
    memoryCount: number,
  ): string[] {
    const issues: string[] = [];

    const requiredHeadings = [
      "# Action Summary",
      "# Evidence Map",
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
    if (
      thesis.includes("# Action Summary") &&
      thesis.includes("# Evidence Map") &&
      thesis.includes("# Overview") &&
      (thesis.indexOf("# Action Summary") > thesis.indexOf("# Evidence Map") ||
        thesis.indexOf("# Evidence Map") > thesis.indexOf("# Overview"))
    ) {
      issues.push("Heading order must be Action Summary, Evidence Map, then Overview.");
    }

    const actionSummarySection = this.extractHeadingSection(
      thesis,
      "Action Summary",
    );
    const evidenceMapSection = this.extractHeadingSection(thesis, "Evidence Map");
    if (!actionSummarySection) {
      issues.push("Action Summary section content is missing.");
    }

    const parsedDecisionLine = this.parseDecisionLine(actionSummarySection);
    const decision = parsedDecisionLine.decision;
    if (!decision) {
      issues.push(
        "Action Summary Decision must be Buy, Watch, Avoid, Watch (Low Quality), or Insufficient Evidence.",
      );
    } else if (evidenceWeak && decision !== "watch") {
      issues.push("Weak evidence must default Decision to Watch.");
    }

    const requiredActionLabels = [
      "Reasons to invest:",
      "Reasons to stay away:",
      "If/Then triggers:",
      "Thesis invalidation:",
    ];
    requiredActionLabels.forEach((label) => {
      if (!actionSummarySection || !actionSummarySection.includes(label)) {
        issues.push(`Missing Action Summary label: ${label}`);
      }
    });

    if (!evidenceMapSection) {
      issues.push("Evidence Map section content is missing.");
    } else {
      const labelMentions =
        evidenceMapSection.match(
          /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/g,
        ) ?? [];
      if (hasEvidence && labelMentions.length < 3) {
        issues.push("Evidence Map must include traceable citation labels.");
      }
      if (hasEvidence && !/\bM\d+\b/.test(evidenceMapSection)) {
        issues.push("Evidence Map must include metric label mappings (M#).");
      }
    }

    const citationMatches =
      thesis.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/g) ?? [];
    if (hasEvidence && citationMatches.length < 4) {
      issues.push("Citation density is too low for available evidence.");
    }

    if (actionSummarySection && hasEvidence) {
      const actionSummaryCitations =
        actionSummarySection.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/g) ?? [];
      if (actionSummaryCitations.length < 4) {
        issues.push("Action Summary citation density is too low.");
      }
    }

    if (
      hasEvidence &&
      parsedDecisionLine.raw &&
      !parsedDecisionLine.hasCitation
    ) {
      issues.push("Action Summary Decision line must include evidence citation.");
    }
    if (
      parsedDecisionLine.raw &&
      parsedDecisionLine.hasGenericLanguage
    ) {
      issues.push("Action Summary Decision line uses generic placeholder language.");
    }

    const memoryCitations = thesis.match(/\bR\d+\b/g) ?? [];
    if (
      hasEvidence &&
      memoryCitations.length > 0 &&
      citationMatches.length === 0
    ) {
      issues.push(
        "Current-run evidence exists, but thesis relies only on memory citations.",
      );
    }

    if (
      hasEvidence &&
      memoryCount > 0 &&
      !/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(thesis)
    ) {
      issues.push(
        "Directional narrative must anchor to current-run evidence when memory is present.",
      );
    }

    const triggerLines = this.extractActionSubBullets(
      actionSummarySection,
      "If/Then triggers:",
    );
    if (triggerLines.length < 3 || triggerLines.length > 5) {
      issues.push("If/Then triggers must include between 3 and 5 sub-bullets.");
    }
    triggerLines.forEach((line) => {
      const normalized = line.toLowerCase();
      if (!normalized.includes("if ") || !normalized.includes(" then ")) {
        issues.push(`Trigger must be conditional (If ... then ...): ${line}`);
      }
      if (!/\d/.test(normalized) && !/(true|false)/.test(normalized)) {
        issues.push(`Trigger missing numeric or boolean threshold: ${line}`);
      }
      if (!/(upgrade|downgrade|add|reduce|hold|re-evaluate)/.test(normalized)) {
        issues.push(`Trigger missing explicit action verb: ${line}`);
      }
      if (
        normalized.includes("monitor developments") ||
        normalized.includes("watch news") ||
        normalized.includes("stay tuned") ||
        normalized.includes("watch for") ||
        normalized.includes("monitor") ||
        /\bcould\b/.test(normalized) ||
        /\bmay\b/.test(normalized)
      ) {
        issues.push(`Trigger is too generic: ${line}`);
      }
      if (hasEvidence && !/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(line)) {
        issues.push(`Trigger missing citation: ${line}`);
      }
    });

    if (hasEvidence) {
      const sections = thesis
        .split("# ")
        .map((block) => block.trim())
        .filter(Boolean);
      sections.forEach((section) => {
        if (!/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(section)) {
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
      "Replace generic trigger phrasing with threshold/action trigger phrasing.",
      "No placeholder guidance language (watch for/monitor/could/may).",
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
   * Scores final thesis quality deterministically so low-actionability drafts can be replaced with a stable fallback output.
   */
  private scoreThesisQuality(
    thesis: string,
    validationIssues: string[],
    hasEvidence: boolean,
  ): ThesisQualityScore {
    const failedChecks = [...validationIssues];
    let score = 100;

    const triggerLines = this.extractActionSubBullets(
      this.extractHeadingSection(thesis, "Action Summary"),
      "If/Then triggers:",
    );
    if (triggerLines.length < 3) {
      failedChecks.push("insufficient_trigger_count");
      score -= 20;
    }

    const numericOrBooleanTriggerCount = triggerLines.filter((line) =>
      /\d/.test(line) || /(true|false)/i.test(line),
    ).length;
    if (numericOrBooleanTriggerCount < this.thesisTriggerMinNumeric) {
      failedChecks.push("insufficient_numeric_or_boolean_triggers");
      score -= 15;
    }

    const actionableLines = thesis
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^-\s+/.test(line) && !/^-\s+(Reasons to|If\/Then triggers:|Thesis invalidation:|Decision:|Timeframe fit:)/i.test(line));
    const citedActionableCount = actionableLines.filter((line) =>
      /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(line),
    ).length;
    const citationCoveragePct =
      actionableLines.length === 0
        ? 100
        : Math.round((citedActionableCount / actionableLines.length) * 100);
    if (hasEvidence && citationCoveragePct < this.thesisMinCitationCoveragePct) {
      failedChecks.push(
        `low_citation_coverage_${citationCoveragePct}_lt_${this.thesisMinCitationCoveragePct}`,
      );
      score -= 15;
    }

    const genericPattern = /\b(watch for|monitor|stay tuned|could|may)\b/gi;
    // Ignore Evidence Map text so provider headline wording does not falsely penalize thesis phrasing quality.
    const thesisWithoutEvidenceMap = thesis.replace(
      /# Evidence Map\n[\s\S]*?(?=\n# |\s*$)/i,
      "# Evidence Map\n",
    );
    const genericMatches = thesisWithoutEvidenceMap.match(genericPattern) ?? [];
    if (genericMatches.length > this.thesisGenericPhraseMax) {
      failedChecks.push(
        `generic_phrase_count_${genericMatches.length}_gt_${this.thesisGenericPhraseMax}`,
      );
      score -= (genericMatches.length - this.thesisGenericPhraseMax) * 8;
    }

    const parsedDecisionLine = this.parseDecisionLine(
      this.extractHeadingSection(thesis, "Action Summary"),
    );
    const hasDecisionValidationIssue = validationIssues.some((issue) =>
      issue.toLowerCase().includes("decision"),
    );
    if (
      !parsedDecisionLine.raw ||
      !parsedDecisionLine.decision ||
      (hasEvidence && !parsedDecisionLine.hasCitation)
    ) {
      if (!hasDecisionValidationIssue) {
        failedChecks.push("weak_or_uncited_decision_line");
      }
      score -= 8;
    }

    const uniqueValidationIssues = Array.from(new Set(validationIssues));
    score -= Math.min(28, uniqueValidationIssues.length * 5);
    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      failedChecks: Array.from(new Set(failedChecks)).slice(0, 20),
    };
  }

  /**
   * Renders a deterministic fallback thesis so runs still produce executable guidance when LLM output remains low quality after repair.
   */
  private buildDeterministicFallbackThesis(args: {
    actionDecision: ActionDecision;
    actionMatrix: ActionMatrixRow[];
    evidenceMapLines: string;
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    relevanceSelection: RelevanceSelection;
  }): string {
    const decisionLabel =
      args.actionDecision === "buy"
        ? "Buy"
        : args.actionDecision === "avoid"
          ? "Avoid"
          : args.actionDecision === "watch_low_quality"
            ? "Watch (Low Quality)"
            : args.actionDecision === "insufficient_evidence"
              ? "Insufficient Evidence"
              : "Watch";
    const citations = args.actionMatrix.flatMap((row) => row.citations).filter(Boolean);
    const primaryCitation = citations[0] ?? "M1";
    const actionMatrixTriggers = args.actionMatrix
      .slice(0, 5)
      .map(
        (row) =>
          `  - If ${row.condition.replace(/^If\s+/i, "").replace(/\.$/, "")}, ${row.action} (${row.citations.join(", ")})`,
      )
      .join("\n");

    const missingFields: string[] = [];
    const metricNames = new Set(args.metrics.map((metric) => metric.metricName));
    if (!metricNames.has("revenue_growth_yoy")) {
      missingFields.push("revenue_growth_yoy");
    }
    if (!metricNames.has("price_to_earnings")) {
      missingFields.push("price_to_earnings");
    }
    if (!metricNames.has("analyst_buy_ratio")) {
      missingFields.push("analyst_buy_ratio");
    }

    const triggerLines =
      args.actionDecision === "insufficient_evidence"
        ? [
            `  - If at least 2 issuer-specific headlines with direct KPI linkage are captured in 14 days, then re-evaluate decision confidence (${primaryCitation})`,
            `  - If a new filing confirms quantified guidance=true or demand_strength=true, then re-evaluate directional stance (${primaryCitation})`,
            `  - If at least 3 core metrics are refreshed with current as-of dates, then re-evaluate evidence quality (${primaryCitation})`,
          ].join("\n")
        : args.actionDecision === "watch_low_quality"
          ? [
              `  - If sector KPI coverage rises above 1 optional KPI while core KPI coverage stays intact for 2 cycles, then increase conviction one level (${primaryCitation})`,
              `  - If filing risk facts switch to true, then reduce risk exposure (${primaryCitation})`,
              `  - If two sequential refresh cycles keep sector KPI coverage at 0 through next earnings, then keep position sizing unchanged (${primaryCitation})`,
            ].join("\n")
          : actionMatrixTriggers;

    const reasonsToInvestSecondLine =
      args.actionDecision === "insufficient_evidence"
        ? `  - Current evidence map is useful for triage, but not yet sufficient for high-conviction direction [${primaryCitation}]`
        : `  - Evidence coverage includes ${args.metrics.length} metrics, ${args.filings.length} filings, and ${args.selectedDocs.length} issuer-matched headlines [${primaryCitation}]`;
    const reasonsToStayAwaySecondLine =
      args.actionDecision === "insufficient_evidence"
        ? `  - Missing structured fields block durable confirmation: ${missingFields.length > 0 ? missingFields.join(", ") : "none"} [${primaryCitation}]`
        : `  - Missing structured fields can reduce conviction: ${missingFields.length > 0 ? missingFields.join(", ") : "none"} [${primaryCitation}]`;
    const conclusionLine =
      args.actionDecision === "insufficient_evidence"
        ? `Decision remains ${decisionLabel} until evidence checkpoints are satisfied and trigger thresholds can be audited [${primaryCitation}].`
        : `Decision remains ${decisionLabel} under deterministic policy gates until missing evidence is filled and trigger thresholds are re-evaluated [${primaryCitation}].`;
    const overviewLine =
      args.actionDecision === "insufficient_evidence"
        ? `Current evidence is incomplete for a directional call; focus stays on collecting issuer-linked KPI and filing checkpoints [${primaryCitation}].`
        : args.actionDecision === "watch_low_quality"
          ? `Core evidence is present, but sector-quality depth is below strong-note thresholds and requires confirmation [${primaryCitation}].`
          : `Current evidence supports a monitored ${decisionLabel} stance, with outcome driven by upcoming KPI and filing checkpoints [${primaryCitation}].`;
    const shareholderLine =
      args.actionDecision === "insufficient_evidence"
        ? `No reliable shareholder/institutional change signal is available yet; do not infer positioning shifts from current data [${primaryCitation}].`
        : `Available shareholder/institutional signals are limited, so stance is anchored to operating and filing checkpoints [${primaryCitation}].`;
    const valuationLine =
      args.actionDecision === "insufficient_evidence"
        ? `Valuation interpretation is provisional until missing core metrics are refreshed and linked to issuer-specific catalysts [${primaryCitation}].`
        : `Valuation view is tied to current metric thresholds and will be re-scored at the next evidence checkpoint [${primaryCitation}].`;
    const filingsLine =
      args.actionDecision === "insufficient_evidence"
        ? `Next filing updates are required to confirm whether guidance, demand, and risk flags support a directional thesis [${primaryCitation}].`
        : `Filing signals are used as hard checkpoints for trigger validation and thesis invalidation [${primaryCitation}].`;

    return [
      "# Action Summary",
      `- Decision: ${decisionLabel} [${primaryCitation}]`,
      `- Timeframe fit: Short-term (0-3m) signal-gated; Long-term (12m+) conviction only with sustained evidence [${primaryCitation}]`,
      "- Reasons to invest:",
      `  - Deterministic signal set indicates measurable upside conditions when thresholds are met [${primaryCitation}]`,
      reasonsToInvestSecondLine,
      "- Reasons to stay away:",
      `  - Evidence quality remains constrained by excluded/noisy headlines (${args.relevanceSelection.excludedHeadlinesCount}) [${primaryCitation}]`,
      reasonsToStayAwaySecondLine,
      "- If/Then triggers:",
      triggerLines,
      "- Thesis invalidation:",
      `  - If two or more core evidence checkpoints fail in sequence, then hold current stance (${primaryCitation})`,
      `  - If filing risk facts switch to true (regulatory or risk-factor flags), then reduce risk exposure (${primaryCitation})`,
      "",
      "# Evidence Map",
      args.evidenceMapLines,
      "",
      "# Overview",
      overviewLine,
      "",
      "# Shareholder/Institutional Dynamics",
      shareholderLine,
      "",
      "# Valuation and Growth Interpretation",
      valuationLine,
      "",
      "# Regulatory Filings",
      filingsLine,
      "",
      "# Missing Evidence",
      `Missing deterministic fields: ${missingFields.length > 0 ? missingFields.join(", ") : "none"} [${primaryCitation}].`,
      "",
      "# Conclusion",
      conclusionLine,
    ].join("\n");
  }

  /**
   * Parses one decision line into normalized action, citation presence, and generic-language flags so validation/scoring use one rule set.
   */
  private parseDecisionLine(actionSummarySection: string | null): {
    raw: string | null;
    decision: ActionDecision | null;
    hasCitation: boolean;
    hasGenericLanguage: boolean;
  } {
    if (!actionSummarySection) {
      return {
        raw: null,
        decision: null,
        hasCitation: false,
        hasGenericLanguage: false,
      };
    }

    const raw = actionSummarySection
      .split("\n")
      .find((line) => /decision:/i.test(line)) ?? null;
    if (!raw) {
      return {
        raw: null,
        decision: null,
        hasCitation: false,
        hasGenericLanguage: false,
      };
    }

    const normalized = raw.toLowerCase();
    let decision: ActionDecision | null = null;
    if (/decision:\s*watch\s*\(low quality\)\b/i.test(raw)) {
      decision = "watch_low_quality";
    } else if (/decision:\s*insufficient evidence\b/i.test(raw)) {
      decision = "insufficient_evidence";
    } else if (/decision:\s*buy\b/i.test(raw)) {
      decision = "buy";
    } else if (/decision:\s*avoid\b/i.test(raw)) {
      decision = "avoid";
    } else if (/decision:\s*watch\b/i.test(raw)) {
      decision = "watch";
    }

    return {
      raw,
      decision,
      hasCitation: /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(raw),
      hasGenericLanguage: /(watch for|monitor|stay tuned|could\b|may\b)/i.test(
        normalized,
      ),
    };
  }

  /**
   * Extracts markdown section body by heading so validation can apply section-specific quality checks.
   */
  private extractHeadingSection(thesis: string, heading: string): string | null {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `# ${escapedHeading}\\n([\\s\\S]*?)(\\n# |$)`,
      "i",
    );
    const match = thesis.match(regex);
    return match?.[1]?.trim() ?? null;
  }

  /**
   * Parses the action decision label so weak-evidence policy can enforce conservative directional output.
   */
  private extractDecision(actionSummarySection: string | null): ActionDecision | null {
    return this.parseDecisionLine(actionSummarySection).decision;
  }

  /**
   * Collects sub-bullets under a labeled action block so trigger quality and citation checks remain deterministic.
   */
  private extractActionSubBullets(
    actionSummarySection: string | null,
    label: string,
  ): string[] {
    if (!actionSummarySection) {
      return [];
    }

    const lines = actionSummarySection.split("\n");
    const labelIndex = lines.findIndex((line) => line.includes(label));
    if (labelIndex < 0) {
      return [];
    }

    const bullets: string[] = [];
    for (let index = labelIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (!line) {
        continue;
      }

      if (
        /^(?:-\s+)?(?:Reasons to invest:|Reasons to stay away:|If\/Then triggers:|Thesis invalidation:)/i.test(
          line,
        )
      ) {
        break;
      }

      if (/^[-*]\s+/.test(line)) {
        bullets.push(line);
      } else {
        break;
      }
    }

    return bullets;
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
   * Enforces Stage-1 minimum evidence requirements so low-data runs return insufficient-evidence decisions deterministically.
   */
  private buildEvidenceGate(args: {
    filingsCount: number;
    kpiCoverage: KpiCoverageDiagnostics;
    valuationAvailable: boolean;
    catalystsCount: number;
    falsifiersCount: number;
  }): EvidenceGateDiagnostics {
    const failures: string[] = [];
    const missingFields: string[] = [];

    if (args.filingsCount < 1) {
      failures.push("missing_filing_evidence");
      missingFields.push("filings");
    }
    if (
      args.kpiCoverage.coreCurrentCount + args.kpiCoverage.coreCarriedCount <
      args.kpiCoverage.coreRequiredCount
    ) {
      failures.push("insufficient_core_kpi_items");
      missingFields.push("kpis");
    }
    if (
      args.kpiCoverage.sectorExpectedCount > 0 &&
      args.kpiCoverage.sectorCurrentCount + args.kpiCoverage.sectorCarriedCount <
        1
    ) {
      failures.push("low_sector_kpi_quality");
    }
    if (!args.valuationAvailable) {
      failures.push("missing_valuation_context");
      missingFields.push("valuation_context");
    }
    if (args.catalystsCount + args.falsifiersCount < 1) {
      failures.push("missing_catalyst_or_falsifier");
      missingFields.push("catalyst_or_falsifier");
    }

    return {
      passed: failures.length === 0,
      failures,
      missingFields,
    };
  }

  /**
   * Converts deterministic policy decision and evidence gate into a Stage-1 action decision compatible with investor-facing output.
   */
  private toActionDecision(
    decision: ThesisDecision,
    gate: EvidenceGateDiagnostics,
    kpiCoverage: KpiCoverageDiagnostics,
  ): ActionDecision {
    const gateFailures = new Set(gate.failures);
    const hasNonKpiFailure = [...gateFailures].some(
      (failure) =>
        failure !== "insufficient_core_kpi_items" &&
        failure !== "low_sector_kpi_quality",
    );
    if (hasNonKpiFailure) {
      return "insufficient_evidence";
    }

    if (gateFailures.has("insufficient_core_kpi_items")) {
      return "insufficient_evidence";
    }

    if (
      this.graceAllowOnSectorWeakness &&
      gateFailures.has("low_sector_kpi_quality") &&
      kpiCoverage.mode === "grace_low_quality"
    ) {
      return "watch_low_quality";
    }

    if (!gate.passed) {
      return "insufficient_evidence";
    }

    if (decision === "buy") {
      return "buy";
    }
    if (decision === "avoid") {
      return "avoid";
    }
    return "watch";
  }

  /**
   * Bounds position sizing to conservative defaults so Stage-1 outputs do not overstate confidence.
   */
  private toPositionSizing(decision: ActionDecision): PositionSizing {
    if (decision === "insufficient_evidence") {
      return "none";
    }
    if (decision === "buy") {
      return "medium";
    }
    return "small";
  }

  /**
   * Derives falsification objects from action rows so investor notes use structured, auditable thesis break conditions.
   */
  private buildFalsification(actionMatrix: ActionMatrixRow[]): FalsificationCondition[] {
    return actionMatrix.slice(0, 3).map((row) => ({
      condition: row.condition,
      type: row.hasNumericThreshold ? "numeric" : "event",
      thresholdOrOutcome: row.currentValue,
      deadline: "next earnings cycle",
      actionIfHit: row.action,
      evidenceRefs: row.citations,
    }));
  }

  /**
   * Estimates decomposed confidence dimensions so data, thesis quality, and timing confidence are visible independently.
   */
  private buildConfidenceDecomposition(args: {
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    now: Date;
    relevanceCoverage: number;
    horizonScore: number;
    evidenceGate: EvidenceGateDiagnostics;
    fallbackApplied: boolean;
    issuerAnchorCount: number;
  }): ConfidenceDecomposition {
    const dataConfidence = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          this.computeConfidence(
            args.selectedDocs,
            args.metrics,
            args.filings,
            args.now,
            args.relevanceCoverage,
          ) * 100,
        ),
      ),
    );

    let thesisConfidence = Math.round(
      (args.evidenceGate.passed ? 62 : 38) +
        Math.min(18, args.metrics.length * 2) +
        Math.min(10, args.filings.length * 3),
    );
    if (!args.evidenceGate.passed) {
      thesisConfidence = Math.min(thesisConfidence, 40);
    }
    if (args.fallbackApplied) {
      thesisConfidence = Math.min(thesisConfidence, 50);
    }
    if (args.issuerAnchorCount < 2) {
      thesisConfidence = Math.min(thesisConfidence, 55);
    }

    let timingConfidence = Math.max(
      0,
      Math.min(
        100,
        Math.round(args.horizonScore + Math.min(12, args.selectedDocs.length * 2)),
      ),
    );
    if (args.fallbackApplied) {
      timingConfidence = Math.min(timingConfidence, 60);
    }
    if (args.issuerAnchorCount < 2) {
      timingConfidence = Math.min(timingConfidence, 65);
    }

    return {
      dataConfidence,
      thesisConfidence: Math.max(0, Math.min(100, thesisConfidence)),
      timingConfidence,
    };
  }

  /**
   * Projects selected KPI names into investor-facing KPI cards, skipping unresolved or uncited KPI entries.
   */
  private buildInvestorKpis(
    selectedKpiNames: string[],
    metricLabelByName: Map<string, string>,
    metrics: MetricPointEntity[],
  ): InvestorKpi[] {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    return selectedKpiNames.slice(0, 10).flatMap((name) => {
      const metric = byName.get(name);
      const label = metricLabelByName.get(name);
      if (!metric || !label) {
        return [];
      }

      const value = this.formatMetricValue(metric);
      if (value === "n/a") {
        return [];
      }

      const trend: InvestorKpi["trend"] =
        name.includes("growth") ? "up" : name.includes("volatility") ? "mixed" : "unknown";
      return [{
        name,
        value,
        trend,
        whyItMatters: `Tracks ${name.replace(/_/g, " ")} as a core thesis checkpoint.`,
        evidenceRefs: [label],
      }];
    });
  }

  /**
   * Resolves investor catalyst evidence refs so no synthetic news labels are emitted when selected news is empty.
   */
  private resolveCatalystEvidenceRefs(args: {
    index: number;
    selectedNewsLabels: string[];
    metricCount: number;
    filingCount: number;
  }): string[] {
    if (args.selectedNewsLabels.length > 0) {
      const label =
        args.selectedNewsLabels[
          Math.min(args.index, Math.max(0, args.selectedNewsLabels.length - 1))
        ];
      return label ? [label] : [];
    }

    if (args.metricCount > 0) {
      return [`M${(args.index % args.metricCount) + 1}`];
    }

    if (args.filingCount > 0) {
      return [`F${(args.index % args.filingCount) + 1}`];
    }

    return [];
  }

  /**
   * Computes lightweight citation linkage diagnostics so diagnostics can expose citation coverage and unlinked claim count.
   */
  private computeCitationDiagnostics(thesis: string): {
    citationCoveragePct: number;
    unlinkedClaimsCount: number;
  } {
    const claimLines = thesis
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- ") && line.length > 8);
    if (claimLines.length === 0) {
      return {
        citationCoveragePct: 100,
        unlinkedClaimsCount: 0,
      };
    }
    const linked = claimLines.filter((line) =>
      /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(line),
    );
    const citationCoveragePct = Math.round((linked.length / claimLines.length) * 100);
    return {
      citationCoveragePct,
      unlinkedClaimsCount: claimLines.length - linked.length,
    };
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

    const relevanceSelection = this.selectRelevantDocuments(
      docs,
      payload.symbol,
      payload.resolvedIdentity,
      payload.horizonContext?.horizon ?? "1_2_quarters",
      payload.kpiContext?.selected ?? payload.kpiContext?.required ?? [],
    );
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
    const shouldForceIdentityUncertainty = this.shouldForceIdentityUncertainty(
      payload.resolvedIdentity,
      relevanceSelection,
    );
    const decisionContext = this.buildDecisionContext(
      relevanceSelection,
      latestMetrics,
      filings,
    );
    const evidenceWeak = decisionContext.evidenceWeak;
    const decisionResult = this.deriveDecisionFromContext(decisionContext);
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
    const actionMatrix = this.buildActionMatrix(
      latestMetrics,
      filings,
      metricLabelByName,
      filingLabelByFactName,
    );
    const actionMatrixLines = this.formatActionMatrix(actionMatrix);
    const falsification = this.buildFalsification(actionMatrix);
    const now = this.clock.now();
    const valuationView = this.deriveValuationView(latestMetrics);
    const derivedCatalysts = this.deriveCatalysts(selectedDocs, latestMetrics, filings);
    const fallbackSelectedKpiNames = latestMetrics
      .slice(0, 8)
      .map((metric) => metric.metricName);
    const kpiCoverage = await this.computeKpiCoverage({
      payload,
      now,
      fallbackSelectedKpiNames,
    });
    const evidenceGate = this.buildEvidenceGate({
      filingsCount: filings.length,
      kpiCoverage: kpiCoverage.diagnostics,
      valuationAvailable: !valuationView.toLowerCase().includes("unavailable"),
      catalystsCount: derivedCatalysts.length,
      falsifiersCount: falsification.length,
    });
    const actionDecision = this.toActionDecision(
      decisionResult.decision,
      evidenceGate,
      kpiCoverage.diagnostics,
    );
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
    const memoryLines = this.formatMemoryLines(memoryMatches);
    const evidenceMapLines = this.buildEvidenceMapLines(
      selectedDocs,
      relevanceSelection.newsLabelByDocumentId,
      promptMetrics,
      filings,
      memoryMatches,
    );

    const prompt = this.buildSynthesisPrompt({
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

    let thesis = this.upsertActionSummaryDeterminism(
      this.upsertEvidenceMapSection(thesisResult.value, evidenceMapLines),
      decisionResult.decision,
      actionMatrix,
    );
    const hasEvidence = selectedDocs.length + promptMetrics.length + filings.length > 0;
    const initialValidationIssues = this.validateThesis(
      thesis,
      hasEvidence,
      shouldForceIdentityUncertainty,
      evidenceWeak,
      memoryMatches.length,
    );
    let finalValidationIssues = initialValidationIssues;

    if (initialValidationIssues.length > 0) {
      const repairPrompt = this.buildRepairPrompt(
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

      const repairedThesis = this.upsertActionSummaryDeterminism(
        this.upsertEvidenceMapSection(repairedResult.value, evidenceMapLines),
        decisionResult.decision,
        actionMatrix,
      );
      const repairedIssues = this.validateThesis(
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

    let thesisQuality = this.scoreThesisQuality(
      thesis,
      finalValidationIssues,
      hasEvidence,
    );
    let fallbackApplied = false;
    const fallbackTriggeredByScore = thesisQuality.score;
    if (fallbackTriggeredByScore < this.thesisQualityMinScore) {
      thesis = this.buildDeterministicFallbackThesis({
        actionDecision,
        actionMatrix,
        evidenceMapLines,
        selectedDocs,
        metrics: promptMetrics,
        filings,
        relevanceSelection,
      });
      fallbackApplied = true;
      finalValidationIssues = this.validateThesis(
        thesis,
        hasEvidence,
        shouldForceIdentityUncertainty,
        evidenceWeak,
        memoryMatches.length,
      );
      thesisQuality = this.scoreThesisQuality(
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
    thesis = this.upsertFinalDecisionPresentation(
      thesis,
      actionDecision,
      actionMatrix,
    );
    const confidenceV2 = this.buildConfidenceDecomposition({
      selectedDocs,
      metrics: latestMetrics,
      filings,
      now,
      relevanceCoverage,
      horizonScore: payload.horizonContext?.score ?? 55,
      evidenceGate,
      fallbackApplied,
      issuerAnchorCount: relevanceSelection.issuerAnchorCount,
    });
    const citationDiagnostics = this.computeCitationDiagnostics(thesis);
    const investorKpis = this.buildInvestorKpis(
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
      evidenceRefs: this.resolveCatalystEvidenceRefs({
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
        decision: actionDecision,
        positionSizing: this.toPositionSizing(actionDecision),
      },
      horizon: {
        bucket: (payload.horizonContext?.horizon ?? "1_2_quarters") as HorizonBucket,
        rationale:
          payload.horizonContext?.rationale ??
          "Intermediate horizon selected because evidence strength is mixed.",
      },
      summary: {
        oneLineThesis:
          actionDecision === "insufficient_evidence"
            ? "Evidence is currently insufficient for a high-conviction directional call."
            : actionDecision === "watch_low_quality"
              ? "Core KPI evidence is present, but sector KPI quality is weak and requires tighter monitoring."
              : `Current evidence supports a ${actionDecision} stance with explicit KPI and catalyst checkpoints.`,
      },
      variantView: {
        pricedInNarrative: "Market is pricing continuation of current operating trajectory.",
        ourVariant:
          actionDecision === "insufficient_evidence"
            ? "Evidence quality is not yet strong enough to support a differentiated variant view."
            : actionDecision === "watch_low_quality"
              ? "Core KPI direction is visible, but sector-specific KPI depth is not yet broad enough for a stronger call."
            : "Upside/downside asymmetry depends on KPI durability through upcoming checkpoints.",
        whyMispriced:
          actionDecision === "insufficient_evidence"
            ? "Signal set is incomplete."
            : actionDecision === "watch_low_quality"
              ? "Partial KPI coverage can understate sector-specific risks and opportunities."
            : "Current narrative may over/underweight near-term KPI durability versus valuation.",
      },
      drivers: investorDrivers.slice(0, 4),
      keyKpis: investorKpis.slice(0, 10),
      catalysts: investorCatalysts.slice(0, 5),
      falsification: falsification.slice(0, 3),
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
        evidenceGate,
        kpiCoverage: kpiCoverage.diagnostics,
        missingFields: evidenceGate.missingFields,
        citationCoveragePct: citationDiagnostics.citationCoveragePct,
        unlinkedClaimsCount: citationDiagnostics.unlinkedClaimsCount,
      },
      createdAt: now,
    });
  }
}

import type {
  DocumentEntity,
  NewsEvidenceClass,
} from "../../../core/entities/document";
import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type {
  ActionDecision,
  ConfidenceDecomposition,
  DecisionScoreBreakdown,
  HorizonBucket,
  InvestorKpi,
  KpiCoverageDiagnostics,
  ResolvedCompanyIdentity,
  SignalPack,
  SnapshotStageDiagnostics,
  SufficiencyDiagnostics,
} from "../../../core/entities/research";
import type {
  EmbeddingMemoryMatch,
  JobPayload,
} from "../../../core/ports/outboundPorts";
import type { NewsDocumentClass } from "../newsScoringV2";

export type RankedDocument = {
  doc: DocumentEntity;
  score: number;
  isRelevant: boolean;
};

export type ExcludedHeadlineReason =
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

export type RelevanceSelection = {
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

export type ThesisDecision = "buy" | "watch" | "avoid";
export type RelevanceMode = "high_precision" | "balanced";

export type IssuerIdentityPatterns = {
  symbolExactTokens: Set<string>;
  symbolPhraseTokens: Set<string>;
  aliasExactTokens: Set<string>;
  aliasPhraseTokens: Set<string>;
  companyExactTokens: Set<string>;
  companyPhraseTokens: Set<string>;
  exactTokens: Set<string>;
  phraseTokens: Set<string>;
};

export type IssuerMatchField =
  | "title"
  | "summary"
  | "content"
  | "payload"
  | "alias"
  | "company";

export type IssuerMatchResult = {
  matched: boolean;
  fieldsMatched: number;
  matchedFields: IssuerMatchField[];
  payloadOnlyMatch: boolean;
  reason?: ExcludedHeadlineReason;
};

export type ThesisCheckpoint = {
  kind: "supports" | "falsifies" | "catalyst";
  text: string;
  evidenceRefs: string[];
  deadline?: string;
};

export type ThesisQualityScore = {
  score: number;
  failedChecks: string[];
};

export type KpiCoverageComputation = {
  selectedCurrentKpiNames: string[];
  diagnostics: KpiCoverageDiagnostics;
};

export interface SynthesisNormalizedSignalPort {
  /**
   * Converts raw and historical metric points into deterministic normalized signals for decision scoring.
   */
  buildSignalPack(args: {
    metrics: MetricPointEntity[];
    now: Date;
    selectedKpiNames: string[];
  }): SignalPack;
}

export interface SynthesisEvidenceSelectorPort {
  /**
   * Selects issuer-relevant evidence candidates and produces diagnostics for synthesis/persistence.
   */
  selectRelevantDocuments(args: {
    docs: DocumentEntity[];
    symbol: string;
    identity: ResolvedCompanyIdentity | undefined;
    horizon: HorizonBucket;
    selectedKpiNames: string[];
  }): RelevanceSelection;

  /**
   * Decides whether synthesis must force identity uncertainty messaging based on resolution confidence and evidence quality.
   */
  shouldForceIdentityUncertainty(
    identity: ResolvedCompanyIdentity | undefined,
    selection: RelevanceSelection,
  ): boolean;
}

export interface SynthesisDecisionPolicyPort {
  /**
   * Produces concise business checkpoints for investor-facing catalysts/falsifiers/supporting conditions.
   */
  buildCheckpoints(args: {
    signalPack: SignalPack;
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    metricLabelByName: Map<string, string>;
    filingLabelByFactName: Map<string, string>;
    selectedNewsLabels: string[];
    horizon: HorizonBucket;
  }): ThesisCheckpoint[];

  /**
   * Scores evidence sufficiency on a continuous scale before directional decisioning.
   */
  buildSufficiencyDiagnostics(args: {
    selection: RelevanceSelection;
    signalPack: SignalPack;
    kpiCoverage: KpiCoverageDiagnostics;
    filingsCount: number;
    valuationAvailable: boolean;
    catalystsCount: number;
    falsifiersCount: number;
  }): SufficiencyDiagnostics;

  /**
   * Derives directional seed plus weighted score diagnostics from normalized signals.
   */
  deriveDecisionFromSignals(args: {
    signalPack: SignalPack;
    sufficiency: SufficiencyDiagnostics;
    selection: RelevanceSelection;
    filings: FilingEntity[];
  }): {
    decision: ThesisDecision;
    reasons: string[];
    scoreBreakdown: DecisionScoreBreakdown;
  };

  /**
   * Maps directional seed plus sufficiency result into public action decision.
   */
  toActionDecision(
    decision: ThesisDecision,
    sufficiency: SufficiencyDiagnostics,
    kpiCoverage: KpiCoverageDiagnostics,
  ): ActionDecision;

  /**
   * Derives position sizing from final action decision.
   */
  toPositionSizing(decision: ActionDecision): "none" | "small" | "medium";

  /**
   * Converts business checkpoints into structured falsification blocks.
   */
  buildFalsification(checkpoints: ThesisCheckpoint[]): Array<{
    condition: string;
    type: "numeric" | "event" | "timing";
    thresholdOrOutcome: string;
    deadline: string;
    actionIfHit: string;
    evidenceRefs: string[];
  }>;
}

export interface SynthesisPromptBuilderPort {
  /**
   * Builds the synthesis prompt contract for first-pass generation.
   */
  buildSynthesisPrompt(args: {
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
    decisionFromContext: ThesisDecision;
    decisionReasonLines: string;
    relevanceSelection: RelevanceSelection;
    shouldForceIdentityUncertainty: boolean;
    evidenceWeak: boolean;
  }): string;

  /**
   * Renders compact memory lines for R# references.
   */
  formatMemoryLines(matches: EmbeddingMemoryMatch[]): string;

  /**
   * Builds deterministic evidence map lines for post-processing.
   */
  buildEvidenceMapLines(
    docs: DocumentEntity[],
    newsLabelByDocumentId: Map<string, string>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    memoryMatches: EmbeddingMemoryMatch[],
  ): string;

  /**
   * Builds one-shot repair prompt from validation failures.
   */
  buildRepairPrompt(
    basePrompt: string,
    draftThesis: string,
    issues: string[],
  ): string;
}

export interface SynthesisThesisGuardPort {
  /**
   * Rewrites evidence map section to deterministic mapping.
   */
  upsertEvidenceMapSection(thesis: string, evidenceMapLines: string): string;

  /**
   * Aligns markdown decision wording with final action decision.
   */
  upsertFinalDecisionPresentation(
    thesis: string,
    decision: ActionDecision,
  ): string;

  /**
   * Validates synthesis output structure and citation/actionability constraints.
   */
  validateThesis(
    thesis: string,
    hasEvidence: boolean,
    shouldForceIdentityUncertainty: boolean,
    evidenceWeak: boolean,
    memoryCount: number,
  ): string[];

  /**
   * Scores thesis quality to decide whether deterministic fallback is required.
   */
  scoreThesisQuality(
    thesis: string,
    validationIssues: string[],
    hasEvidence: boolean,
  ): ThesisQualityScore;

  /**
   * Builds deterministic fallback thesis when generated draft quality remains below floor.
   */
  buildDeterministicFallbackThesis(args: {
    actionDecision: ActionDecision;
    checkpoints: ThesisCheckpoint[];
    evidenceMapLines: string;
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    relevanceSelection: RelevanceSelection;
  }): string;

  /**
   * Computes citation linkage diagnostics for persisted snapshot diagnostics.
   */
  computeCitationDiagnostics(thesis: string): {
    citationCoveragePct: number;
    unlinkedClaimsCount: number;
  };
}

export interface SynthesisInvestorViewBuilderPort {
  /**
   * Decomposes confidence into data/thesis/timing components.
   */
  buildConfidenceDecomposition(args: {
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    now: Date;
    relevanceCoverage: number;
    horizonScore: number;
    sufficiencyDiagnostics: SufficiencyDiagnostics;
    decisionScoreBreakdown: DecisionScoreBreakdown;
    fallbackApplied: boolean;
    issuerAnchorCount: number;
  }): ConfidenceDecomposition;

  /**
   * Converts selected KPI names into investor-facing KPI cards.
   */
  buildInvestorKpis(
    selectedKpiNames: string[],
    metricLabelByName: Map<string, string>,
    metrics: MetricPointEntity[],
  ): InvestorKpi[];

  /**
   * Resolves catalyst evidence refs with deterministic fallback when selected news is sparse.
   */
  resolveCatalystEvidenceRefs(args: {
    index: number;
    selectedNewsLabels: string[];
    metricCount: number;
    filingCount: number;
  }): string[];
}

export type WithStageIssueFn = (
  payload: JobPayload,
  issue: SnapshotStageDiagnostics,
) => JobPayload;

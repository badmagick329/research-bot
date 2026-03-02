export type JobStage =
  | "ingest"
  | "normalize"
  | "classify_stock"
  | "select_horizon"
  | "build_kpi_tree"
  | "embed"
  | "synthesize";

export type ThesisType =
  | "compounder"
  | "cyclical"
  | "turnaround"
  | "event_driven"
  | "asset_play"
  | "capital_return"
  | "special_situation"
  | "value_trap_risk"
  | "unclear";

export type HorizonBucket = "0_4_weeks" | "1_2_quarters" | "1_3_years";

export type ActionDecision =
  | "buy"
  | "watch"
  | "avoid"
  | "watch_low_quality"
  | "insufficient_evidence";

export type PositionSizing = "none" | "small" | "medium";

export type ConfidenceDecomposition = {
  dataConfidence: number;
  thesisConfidence: number;
  timingConfidence: number;
};

export type FalsificationCondition = {
  condition: string;
  type: "numeric" | "event" | "timing";
  thresholdOrOutcome: string;
  deadline: string;
  actionIfHit: string;
  evidenceRefs: string[];
};

export type InvestorKpi = {
  name: string;
  value: string;
  trend: "up" | "down" | "flat" | "mixed" | "unknown";
  whyItMatters: string;
  evidenceRefs: string[];
};

export type InvestorCatalyst = {
  event: string;
  window: string;
  expectedDirection: string;
  whyItMatters: string;
  evidenceRefs: string[];
};

export type InvestorDriver = {
  driver: string;
  kpis: string[];
  evidenceRefs: string[];
};

export type InvestorViewV2 = {
  thesisType: ThesisType;
  action: {
    decision: ActionDecision;
    positionSizing: PositionSizing;
  };
  horizon: {
    bucket: HorizonBucket;
    rationale: string;
  };
  summary: {
    oneLineThesis: string;
  };
  variantView: {
    pricedInNarrative: string;
    ourVariant: string;
    whyMispriced: string;
  };
  drivers: InvestorDriver[];
  keyKpis: InvestorKpi[];
  catalysts: InvestorCatalyst[];
  falsification: FalsificationCondition[];
  valuation: {
    valuationFramework: string;
    keyMultiples: string[];
    historyContext: string;
    peerContext: string;
    valuationView: "cheap" | "fair" | "expensive" | "uncertain";
  };
  confidence: ConfidenceDecomposition;
};

export type ThesisTypeContext = {
  thesisType: ThesisType;
  reasonCodes: string[];
  score: number;
};

export type HorizonContext = {
  horizon: HorizonBucket;
  rationale: string;
  score: number;
};

export type KpiTemplateName =
  | "software_saas"
  | "semis"
  | "retail_consumer"
  | "banks"
  | "energy_materials"
  | "generic";

export type KpiTemplateContext = {
  template: KpiTemplateName;
  required: string[];
  optional: string[];
  selected: string[];
  requiredHitCount: number;
  minRequiredForStrongNote: number;
};

export type EvidenceGateDiagnostics = {
  passed: boolean;
  failures: string[];
  missingFields: string[];
};

export type KpiCoverageDiagnostics = {
  mode: "strict" | "grace_low_quality";
  coreRequiredCount: number;
  coreCurrentCount: number;
  coreCarriedCount: number;
  sectorExpectedCount: number;
  sectorCurrentCount: number;
  sectorCarriedCount: number;
  carryForwardMaxAgeDays: number;
  carriedKpis: Array<{
    name: string;
    ageDays: number;
    usedForGate: boolean;
  }>;
};

export type NormalizedSignalDirection = "positive" | "negative" | "neutral";

export type NormalizedSignal = {
  signalId: string;
  metricName: string;
  sourceMetricNames: string[];
  normalizedValue: number;
  direction: NormalizedSignalDirection;
  level: number;
  trend: number;
  acceleration: number;
  freshnessDays: number;
  historyZScore?: number;
  peerZScore?: number;
  confidenceContribution: number;
};

export type SignalPack = {
  signals: NormalizedSignal[];
  coverage: {
    totalSignals: number;
    freshSignals: number;
    staleSignals: number;
    hasPeerRelativeContext: boolean;
  };
};

export type SufficiencyDiagnostics = {
  score: number;
  threshold: number;
  passed: boolean;
  missingCriticalDimensions: string[];
  reasonCodes: string[];
};

export type DecisionScoreBreakdown = {
  buyScore: number;
  avoidScore: number;
  netScore: number;
  reasonCodes: string[];
  contributions: Array<{
    signalId: string;
    weight: number;
    normalizedValue: number;
    contribution: number;
  }>;
};

export type ResearchTaskEntity = {
  id: string;
  runId: string;
  symbol: string;
  requestedAt: Date;
  priority: number;
  stage: JobStage;
  idempotencyKey: string;
};

export type ResolvedCompanyIdentity = {
  requestedSymbol: string;
  canonicalSymbol: string;
  companyName: string;
  aliases: string[];
  exchange?: string;
  confidence: number;
  resolutionSource: "manual_map" | "provider" | "heuristic";
};

export type SnapshotMetricsDiagnostics = {
  provider: string;
  status:
    | "ok"
    | "empty"
    | "rate_limited"
    | "timeout"
    | "provider_error"
    | "auth_invalid"
    | "config_invalid"
    | "malformed_response"
    | "transport_error"
    | "invalid_json";
  metricCount: number;
  reason?: string;
  httpStatus?: number;
};

export type SnapshotProviderFailureStatus =
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "auth_invalid"
  | "config_invalid"
  | "malformed_response"
  | "transport_error"
  | "invalid_json";

export type SnapshotProviderFailureDiagnostics = {
  source: "news" | "metrics" | "filings" | "market-context" | "macro-context";
  provider: string;
  status: SnapshotProviderFailureStatus;
  itemCount: number;
  reason: string;
  httpStatus?: number;
  retryable?: boolean;
};

export type MacroContextProviderDiagnostics = {
  provider: "fred" | "bls";
  status:
    | "ok"
    | "empty"
    | "rate_limited"
    | "timeout"
    | "provider_error"
    | "auth_invalid"
    | "config_invalid"
    | "malformed_response"
    | "transport_error"
    | "invalid_json";
  metricCount: number;
  reason?: string;
  httpStatus?: number;
};

export type SnapshotStageDiagnostics = {
  stage: "normalize" | "embed";
  status: "degraded";
  reason: string;
  provider?: string;
  code?: string;
  retryable?: boolean;
};

export type SnapshotDiagnostics = {
  metrics?: SnapshotMetricsDiagnostics;
  metricsCompanyFacts?: SnapshotMetricsDiagnostics;
  providerFailures?: SnapshotProviderFailureDiagnostics[];
  stageIssues?: SnapshotStageDiagnostics[];
  identity?: ResolvedCompanyIdentity;
  newsQuality?: {
    total: number;
    issuerMatched: number;
    excluded: number;
    mode: string;
    excludedReasonsSample?: string[];
  };
  newsQualityV2?: {
    totalConsidered: number;
    included: number;
    excluded: number;
    averageCompositeScore: number;
    mode: "enforce";
    prefilterClassCountsBefore?: Record<string, number>;
    prefilterClassCountsAfter?: Record<string, number>;
    issuerAnchorAvailable?: boolean;
    issuerAnchorAvailableCount?: number;
    issuerAnchorSelectedCount?: number;
    excludedByReason: Record<string, number>;
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
      documentClass?: string;
      confidenceBand?: string;
    }>;
  };
  readThroughQualityV2?: {
    issuerIncluded: number;
    peerIncluded: number;
    supplyChainIncluded: number;
    customerIncluded: number;
    industryIncluded: number;
    issuerAnchorPresent: boolean;
    excludedByClass: Record<string, number>;
    excludedByClassAndReason: Record<string, Record<string, number>>;
  };
  issuerMatchDiagnostics?: {
    title: number;
    summary: number;
    content: number;
    payload: number;
    payloadOnlyRejected: number;
  };
  macroContext?: {
    totalMetricCount: number;
    providers: MacroContextProviderDiagnostics[];
    selectedForTemplate?: string[];
  };
  decisionReasons?: string[];
  thesisQuality?: {
    score: number;
    failedChecks: string[];
    fallbackApplied: boolean;
  };
  fallbackReasonCodes?: string[];
  evidenceGate?: EvidenceGateDiagnostics;
  kpiCoverage?: KpiCoverageDiagnostics;
  signalDiagnostics?: SignalPack;
  sufficiencyDiagnostics?: SufficiencyDiagnostics;
  decisionScoreBreakdown?: DecisionScoreBreakdown;
  insufficientEvidenceReasons?: string[];
  missingFields?: string[];
  citationCoveragePct?: number;
  unlinkedClaimsCount?: number;
};

export type ResearchSnapshotEntity = {
  id: string;
  runId?: string;
  taskId?: string;
  symbol: string;
  horizon: string;
  score: number;
  thesis: string;
  risks: string[];
  catalysts: string[];
  valuationView: string;
  confidence: number;
  sources: Array<{ provider: string; url?: string; title?: string }>;
  investorViewV2?: InvestorViewV2;
  diagnostics?: SnapshotDiagnostics;
  createdAt: Date;
};

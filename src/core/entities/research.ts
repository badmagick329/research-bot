export type JobStage = "ingest" | "normalize" | "embed" | "synthesize";

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
  source: "news" | "metrics" | "filings";
  provider: string;
  status: SnapshotProviderFailureStatus;
  itemCount: number;
  reason: string;
  httpStatus?: number;
  retryable?: boolean;
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
  providerFailures?: SnapshotProviderFailureDiagnostics[];
  stageIssues?: SnapshotStageDiagnostics[];
  identity?: ResolvedCompanyIdentity;
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
  diagnostics?: SnapshotDiagnostics;
  createdAt: Date;
};

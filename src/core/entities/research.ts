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
    | "malformed_response";
  metricCount: number;
  reason?: string;
  httpStatus?: number;
};

export type SnapshotDiagnostics = {
  metrics?: SnapshotMetricsDiagnostics;
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

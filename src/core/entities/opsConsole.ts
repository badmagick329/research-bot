import type {
  JobStage,
  ResearchSnapshotEntity,
  ResolvedCompanyIdentity,
  SnapshotDiagnostics,
} from "./research";

export type ApiErrorResponse = {
  error: {
    code:
      | "bad_request"
      | "not_found"
      | "conflict"
      | "upstream_error"
      | "internal_error";
    message: string;
    retryable: boolean;
  };
};

export type EnqueueRunRequest = {
  symbol: string;
  force?: boolean;
};

export type EnqueueRunResponse = {
  accepted: true;
  runId: string;
  taskId: string;
  requestedSymbol: string;
  canonicalSymbol: string;
  idempotencyKey: string;
  forceApplied: boolean;
  enqueuedAt: string;
};

export type QueueStageCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

export type QueueStageCountsSample = {
  stage: JobStage;
  sampledAt: string;
  counts: QueueStageCounts;
};

export type QueueCountsResponse = {
  items: QueueStageCountsSample[];
};

export type RunStageStatus = {
  stage: JobStage;
  status:
    | "queued"
    | "running"
    | "success"
    | "degraded"
    | "failed"
    | "not_started";
};

export type RunEvidenceSummary = {
  documents: number;
  metrics: number;
  filings: number;
};

export type RunSummary = {
  runId: string;
  taskId?: string;
  requestedSymbol: string;
  canonicalSymbol: string;
  status: "running" | "success" | "degraded" | "failed";
  diagnostics?: SnapshotDiagnostics;
  evidence: RunEvidenceSummary;
  createdAt: string;
  updatedAt: string;
};

export type ListRunsQuery = {
  symbol?: string;
  limit?: number;
  cursor?: string;
};

export type ListRunsResponse = {
  items: RunSummary[];
  nextCursor?: string;
};

export type RunDetail = {
  runId: string;
  taskId?: string;
  requestedSymbol: string;
  canonicalSymbol: string;
  identity?: ResolvedCompanyIdentity;
  status: "running" | "success" | "degraded" | "failed";
  stages: RunStageStatus[];
  diagnostics?: SnapshotDiagnostics;
  evidence: RunEvidenceSummary;
  latestSnapshot?: ResearchSnapshotEntity;
  createdAt: string;
  updatedAt: string;
};

export type RunDetailResponse = {
  run: RunDetail;
};

export type LatestSnapshotResponse = {
  snapshot: ResearchSnapshotEntity;
};

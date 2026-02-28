import type { DocumentEntity } from "../entities/document";
import type { MetricPointEntity } from "../entities/metric";
import type { FilingEntity } from "../entities/filing";
import type { Result } from "neverthrow";
import type { AppBoundaryError } from "../entities/appError";
import type {
  ListRunsQuery,
  ListRunsResponse,
  QueueCountsResponse,
  RunDetailResponse,
} from "../entities/opsConsole";
import type {
  EvidenceGateDiagnostics,
  HorizonContext,
  JobStage,
  KpiTemplateContext,
  ResearchSnapshotEntity,
  ResolvedCompanyIdentity,
  SnapshotMetricsDiagnostics,
  SnapshotProviderFailureDiagnostics,
  SnapshotStageDiagnostics,
  ThesisTypeContext,
  ResearchTaskEntity,
} from "../entities/research";

export type JobPayload = {
  runId: string;
  taskId: string;
  symbol: string;
  idempotencyKey: string;
  requestedAt: string;
  resolvedIdentity?: ResolvedCompanyIdentity;
  metricsDiagnostics?: SnapshotMetricsDiagnostics;
  providerFailures?: SnapshotProviderFailureDiagnostics[];
  stageIssues?: SnapshotStageDiagnostics[];
  thesisTypeContext?: ThesisTypeContext;
  horizonContext?: HorizonContext;
  kpiContext?: KpiTemplateContext;
  evidenceGate?: EvidenceGateDiagnostics;
};

export type QueueEnqueueReceipt = {
  runId: string;
  taskId: string;
  requestedAt: string;
  enqueuedAt: string;
  deduped: boolean;
};

export type QueueRunState = {
  runId: string;
  taskId: string;
  symbol: string;
  requestedAt: string;
  requestedSymbol: string;
  canonicalSymbol: string;
  status: "running" | "failed";
  stages: RunDetailResponse["run"]["stages"];
  identity?: ResolvedCompanyIdentity;
  updatedAt: string;
};

export interface QueuePort {
  enqueue(stage: JobStage, payload: JobPayload): Promise<void>;
}

export interface QueueReceiptPort {
  enqueueWithReceipt(
    stage: JobStage,
    payload: JobPayload,
  ): Promise<QueueEnqueueReceipt>;
}

export interface QueueCountsReadPort {
  getQueueCountsSampled(): Promise<QueueCountsResponse>;
}

export interface QueueRunReadPort {
  /**
   * Resolves in-flight queue state by run id so monitor UIs can render pre-snapshot progress.
   */
  getRunState(runId: string): Promise<QueueRunState | null>;

  /**
   * Resolves latest in-flight queue state by symbol so list views can include pre-snapshot runs.
   */
  getLatestRunStateBySymbol(symbol: string): Promise<QueueRunState | null>;
}

export interface DocumentRepositoryPort {
  upsertMany(documents: DocumentEntity[]): Promise<void>;
  listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<DocumentEntity[]>;
}

export interface MetricsRepositoryPort {
  upsertMany(metrics: MetricPointEntity[]): Promise<void>;
  listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<MetricPointEntity[]>;
}

export interface FilingsRepositoryPort {
  upsertMany(filings: FilingEntity[]): Promise<void>;
  listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<FilingEntity[]>;
}

export interface EmbeddingRepositoryPort {
  upsertForDocument(
    documentId: string,
    symbol: string,
    runId: string,
    taskId: string,
    embedding: number[],
    content: string,
  ): Promise<void>;
}

export type EmbeddingMemorySearchOptions = {
  limit: number;
  excludeRunId?: string;
  from: Date;
  minSimilarity: number;
};

export type EmbeddingMemoryMatch = {
  documentId: string;
  symbol: string;
  runId?: string;
  content: string;
  similarity: number;
  createdAt: Date;
};

export interface EmbeddingMemoryRepositoryPort {
  /**
   * Retrieves semantically similar historical symbol memory so synthesis can reference prior-run context.
   */
  findSimilarBySymbol(
    symbol: string,
    queryEmbedding: number[],
    options: EmbeddingMemorySearchOptions,
  ): Promise<EmbeddingMemoryMatch[]>;
}

export interface SnapshotRepositoryPort {
  save(snapshot: ResearchSnapshotEntity): Promise<void>;
  latestBySymbol(
    symbol: string,
    runId?: string,
  ): Promise<ResearchSnapshotEntity | null>;
}

export interface RunsReadRepositoryPort {
  listRuns(query: ListRunsQuery): Promise<ListRunsResponse>;
  getRunDetail(runId: string): Promise<RunDetailResponse | null>;
}

export interface LlmPort {
  summarize(prompt: string): Promise<Result<string, AppBoundaryError>>;
  synthesize(prompt: string): Promise<Result<string, AppBoundaryError>>;
}

export interface EmbeddingPort {
  embedTexts(texts: string[]): Promise<Result<number[][], AppBoundaryError>>;
}

export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  next(): string;
}

export interface TaskFactoryPort {
  create(symbol: string, stage: JobStage): ResearchTaskEntity;
}

export type ProviderRateLimitKey = "alphavantage" | "finnhub" | "sec-edgar";

export interface ProviderRateLimiterPort {
  /**
   * Reserves the next outbound slot for a provider so distributed workers honor shared pacing limits.
   */
  waitForSlot(provider: ProviderRateLimitKey): Promise<void>;
}

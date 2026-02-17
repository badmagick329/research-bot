import type { DocumentEntity } from "../entities/document";
import type { MetricPointEntity } from "../entities/metric";
import type { FilingEntity } from "../entities/filing";
import type {
  JobStage,
  ResearchSnapshotEntity,
  ResearchTaskEntity,
} from "../entities/research";

export type JobPayload = {
  taskId: string;
  symbol: string;
  idempotencyKey: string;
  requestedAt: string;
};

export interface QueuePort {
  enqueue(stage: JobStage, payload: JobPayload): Promise<void>;
}

export interface DocumentRepositoryPort {
  upsertMany(documents: DocumentEntity[]): Promise<void>;
  listBySymbol(symbol: string, limit: number): Promise<DocumentEntity[]>;
}

export interface MetricsRepositoryPort {
  upsertMany(metrics: MetricPointEntity[]): Promise<void>;
  listBySymbol(symbol: string, limit: number): Promise<MetricPointEntity[]>;
}

export interface FilingsRepositoryPort {
  upsertMany(filings: FilingEntity[]): Promise<void>;
  listBySymbol(symbol: string, limit: number): Promise<FilingEntity[]>;
}

export interface EmbeddingRepositoryPort {
  upsertForDocument(
    documentId: string,
    symbol: string,
    embedding: number[],
    content: string,
  ): Promise<void>;
}

export interface SnapshotRepositoryPort {
  save(snapshot: ResearchSnapshotEntity): Promise<void>;
  latestBySymbol(symbol: string): Promise<ResearchSnapshotEntity | null>;
}

export interface LlmPort {
  summarize(prompt: string): Promise<string>;
  synthesize(prompt: string): Promise<string>;
}

export interface EmbeddingPort {
  embedTexts(texts: string[]): Promise<number[][]>;
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

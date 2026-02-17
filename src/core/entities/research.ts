export type JobStage = "ingest" | "normalize" | "embed" | "synthesize";

export type ResearchTaskEntity = {
  id: string;
  symbol: string;
  requestedAt: Date;
  priority: number;
  stage: JobStage;
  idempotencyKey: string;
};

export type ResearchSnapshotEntity = {
  id: string;
  symbol: string;
  horizon: string;
  score: number;
  thesis: string;
  risks: string[];
  catalysts: string[];
  valuationView: string;
  confidence: number;
  sources: Array<{ provider: string; url?: string; title?: string }>;
  createdAt: Date;
};

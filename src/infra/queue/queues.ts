import type { JobStage } from "../../core/entities/research";

export const queueNames: Record<JobStage, string> = {
  ingest: "research-ingest",
  normalize: "research-normalize",
  embed: "research-embed",
  synthesize: "research-synthesize",
};

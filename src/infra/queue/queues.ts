import type { JobStage } from "../../core/entities/research";

/**
 * Uses hyphen-only queue names because BullMQ uses colon as an internal Redis key separator.
 */
export const queueNames: Record<JobStage, string> = {
  ingest: "research-ingest",
  normalize: "research-normalize",
  classify_stock: "research-classify-stock",
  select_horizon: "research-select-horizon",
  build_kpi_tree: "research-build-kpi-tree",
  embed: "research-embed",
  synthesize: "research-synthesize",
};

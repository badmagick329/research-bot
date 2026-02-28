export type DocumentType = "news" | "filing" | "transcript" | "analysis";
export type NewsEvidenceClass =
  | "issuer"
  | "peer"
  | "supply_chain"
  | "customer"
  | "industry";

export type DocumentEntity = {
  id: string;
  runId?: string;
  taskId?: string;
  symbol: string;
  provider: string;
  providerItemId: string;
  type: DocumentType;
  title: string;
  summary?: string;
  content: string;
  url?: string;
  publishedAt: Date;
  language?: string;
  topics: string[];
  sourceType: "api" | "rss" | "scrape" | "manual";
  evidenceClass?: NewsEvidenceClass;
  rawPayload: unknown;
  createdAt: Date;
};

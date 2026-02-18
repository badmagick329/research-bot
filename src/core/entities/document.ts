export type DocumentType = "news" | "filing" | "transcript" | "analysis";

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
  rawPayload: unknown;
  createdAt: Date;
};

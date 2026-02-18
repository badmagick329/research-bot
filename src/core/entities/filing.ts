export type FilingEntity = {
  id: string;
  runId?: string;
  taskId?: string;
  symbol: string;
  provider: string;
  dedupeKey: string;
  issuerName: string;
  filingType: string;
  accessionNo?: string;
  filedAt: Date;
  periodEnd?: Date;
  docUrl: string;
  sections: Array<{ name: string; text: string }>;
  extractedFacts: Array<{
    name: string;
    value: string;
    unit?: string;
    period?: string;
  }>;
  rawPayload: unknown;
  createdAt: Date;
};

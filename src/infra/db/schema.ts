import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

export const documentsTable = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    taskId: text("task_id"),
    symbol: text("symbol").notNull(),
    provider: text("provider").notNull(),
    providerItemId: text("provider_item_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    content: text("content").notNull(),
    url: text("url"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    language: text("language"),
    topics: jsonb("topics").$type<string[]>().notNull(),
    sourceType: text("source_type").notNull(),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    providerItemIdx: uniqueIndex("documents_provider_item_uidx").on(
      table.provider,
      table.providerItemId,
    ),
  }),
);

export const metricsTable = pgTable(
  "metrics",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    taskId: text("task_id"),
    symbol: text("symbol").notNull(),
    provider: text("provider").notNull(),
    metricName: text("metric_name").notNull(),
    metricValue: real("metric_value").notNull(),
    metricUnit: text("metric_unit"),
    currency: text("currency"),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    periodType: text("period_type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    confidence: real("confidence"),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    metricNaturalIdx: uniqueIndex("metrics_natural_uidx").on(
      table.symbol,
      table.provider,
      table.metricName,
      table.asOf,
    ),
  }),
);

export const filingsTable = pgTable(
  "filings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    taskId: text("task_id"),
    symbol: text("symbol").notNull(),
    provider: text("provider").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    issuerName: text("issuer_name").notNull(),
    filingType: text("filing_type").notNull(),
    accessionNo: text("accession_no"),
    filedAt: timestamp("filed_at", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    docUrl: text("doc_url").notNull(),
    sections: jsonb("sections")
      .$type<Array<{ name: string; text: string }>>()
      .notNull(),
    extractedFacts: jsonb("extracted_facts")
      .$type<
        Array<{ name: string; value: string; unit?: string; period?: string }>
      >()
      .notNull(),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    dedupeNaturalIdx: uniqueIndex("filings_provider_dedupe_uidx").on(
      table.provider,
      table.dedupeKey,
    ),
  }),
);

export const embeddingsTable = pgTable(
  "embeddings",
  {
    documentId: text("document_id")
      .primaryKey()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    taskId: text("task_id"),
    symbol: text("symbol").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    symbolIdx: index("embeddings_symbol_idx").on(table.symbol),
  }),
);

export const snapshotsTable = pgTable("snapshots", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  taskId: text("task_id"),
  symbol: text("symbol").notNull(),
  horizon: text("horizon").notNull(),
  score: real("score").notNull(),
  thesis: text("thesis").notNull(),
  risks: jsonb("risks").$type<string[]>().notNull(),
  catalysts: jsonb("catalysts").$type<string[]>().notNull(),
  valuationView: text("valuation_view").notNull(),
  confidence: real("confidence").notNull(),
  sources: jsonb("sources")
    .$type<Array<{ provider: string; url?: string; title?: string }>>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { ResearchSnapshotEntity } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  EmbeddingRepositoryPort,
  FilingsRepositoryPort,
  MetricsRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";
import {
  documentsTable,
  filingsTable,
  metricsTable,
  snapshotsTable,
} from "./schema";

/**
 * Persists normalized documents with upsert semantics so provider re-polls stay idempotent.
 */
export class PostgresDocumentRepositoryService implements DocumentRepositoryPort {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  /**
   * Preserves latest provider truth while preventing duplicate records on repeated ingestion windows.
   */
  async upsertMany(documents: DocumentEntity[]): Promise<void> {
    if (documents.length === 0) return;
    await this.db
      .insert(documentsTable)
      .values(documents)
      .onConflictDoUpdate({
        target: [documentsTable.provider, documentsTable.providerItemId],
        set: {
          runId: sql`excluded.run_id`,
          taskId: sql`excluded.task_id`,
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          content: sql`excluded.content`,
          topics: sql`excluded.topics`,
          rawPayload: sql`excluded.raw_payload`,
        },
      });
  }

  /**
   * Serves recent symbol context for downstream pipeline stages from a single durable source.
   */
  async listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<DocumentEntity[]> {
    const whereClause = runId
      ? and(
          eq(documentsTable.symbol, symbol.toUpperCase()),
          eq(documentsTable.runId, runId),
        )
      : eq(documentsTable.symbol, symbol.toUpperCase());

    const rows = await this.db
      .select()
      .from(documentsTable)
      .where(whereClause)
      .orderBy(desc(documentsTable.publishedAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      runId: row.runId ?? undefined,
      taskId: row.taskId ?? undefined,
      summary: row.summary ?? undefined,
      url: row.url ?? undefined,
      language: row.language ?? undefined,
      type: row.type as DocumentEntity["type"],
      sourceType: row.sourceType as DocumentEntity["sourceType"],
    }));
  }
}

/**
 * Stores normalized market metrics so synthesis can blend textual and numeric evidence.
 */
export class PostgresMetricsRepositoryService implements MetricsRepositoryPort {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  /**
   * Keeps metric points fresh without multiplying natural-key duplicates from repeat provider calls.
   */
  async upsertMany(metrics: MetricPointEntity[]): Promise<void> {
    if (metrics.length === 0) return;
    await this.db
      .insert(metricsTable)
      .values(metrics)
      .onConflictDoUpdate({
        target: [
          metricsTable.symbol,
          metricsTable.provider,
          metricsTable.metricName,
          metricsTable.asOf,
        ],
        set: {
          runId: sql`excluded.run_id`,
          taskId: sql`excluded.task_id`,
          metricValue: sql`excluded.metric_value`,
          confidence: sql`excluded.confidence`,
          rawPayload: sql`excluded.raw_payload`,
        },
      });
  }

  /**
   * Exposes latest metric points so synthesis can reason over numeric evidence, not only headlines.
   */
  async listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<MetricPointEntity[]> {
    const whereClause = runId
      ? and(
          eq(metricsTable.symbol, symbol.toUpperCase()),
          eq(metricsTable.runId, runId),
        )
      : eq(metricsTable.symbol, symbol.toUpperCase());

    const rows = await this.db
      .select()
      .from(metricsTable)
      .where(whereClause)
      .orderBy(desc(metricsTable.asOf), desc(metricsTable.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      runId: row.runId ?? undefined,
      taskId: row.taskId ?? undefined,
      metricUnit: row.metricUnit ?? undefined,
      currency: row.currency ?? undefined,
      periodStart: row.periodStart ?? undefined,
      periodEnd: row.periodEnd ?? undefined,
      confidence: row.confidence ?? undefined,
      periodType: row.periodType as MetricPointEntity["periodType"],
    }));
  }
}

/**
 * Persists filing artifacts so regulatory context remains queryable independently from news flow.
 */
export class PostgresFilingsRepositoryService implements FilingsRepositoryPort {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  /**
   * Inserts new filings opportunistically while avoiding rewrite churn for immutable filing records.
   */
  async upsertMany(filings: FilingEntity[]): Promise<void> {
    if (filings.length === 0) return;
    await this.db
      .insert(filingsTable)
      .values(filings)
      .onConflictDoUpdate({
        target: [filingsTable.provider, filingsTable.dedupeKey],
        set: {
          runId: sql`excluded.run_id`,
          taskId: sql`excluded.task_id`,
          symbol: sql`excluded.symbol`,
          issuerName: sql`excluded.issuer_name`,
          filingType: sql`excluded.filing_type`,
          accessionNo: sql`excluded.accession_no`,
          filedAt: sql`excluded.filed_at`,
          periodEnd: sql`excluded.period_end`,
          docUrl: sql`excluded.doc_url`,
          sections: sql`excluded.sections`,
          extractedFacts: sql`excluded.extracted_facts`,
          rawPayload: sql`excluded.raw_payload`,
          createdAt: sql`excluded.created_at`,
        },
      });
  }

  /**
   * Exposes latest filing metadata so synthesis can include regulatory context alongside news flow.
   */
  async listBySymbol(
    symbol: string,
    limit: number,
    runId?: string,
  ): Promise<FilingEntity[]> {
    const whereClause = runId
      ? and(
          eq(filingsTable.symbol, symbol.toUpperCase()),
          eq(filingsTable.runId, runId),
        )
      : eq(filingsTable.symbol, symbol.toUpperCase());

    const rows = await this.db
      .select()
      .from(filingsTable)
      .where(whereClause)
      .orderBy(desc(filingsTable.filedAt), desc(filingsTable.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      runId: row.runId ?? undefined,
      taskId: row.taskId ?? undefined,
      accessionNo: row.accessionNo ?? undefined,
      periodEnd: row.periodEnd ?? undefined,
    }));
  }
}

/**
 * Materializes synthesized outputs as an append-only history to preserve auditability of prior views.
 */
export class PostgresSnapshotRepositoryService implements SnapshotRepositoryPort {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  /**
   * Stores each synthesis result as a point-in-time snapshot for reproducible downstream reads.
   */
  async save(snapshot: ResearchSnapshotEntity): Promise<void> {
    await this.db.insert(snapshotsTable).values(snapshot);
  }

  /**
   * Returns the freshest symbol thesis so operational commands can expose current state quickly.
   */
  async latestBySymbol(
    symbol: string,
    runId?: string,
  ): Promise<ResearchSnapshotEntity | null> {
    const whereClause = runId
      ? and(
          eq(snapshotsTable.symbol, symbol.toUpperCase()),
          eq(snapshotsTable.runId, runId),
        )
      : eq(snapshotsTable.symbol, symbol.toUpperCase());

    const [row] = await this.db
      .select()
      .from(snapshotsTable)
      .where(whereClause)
      .orderBy(desc(snapshotsTable.createdAt))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      ...row,
      runId: row.runId ?? undefined,
      taskId: row.taskId ?? undefined,
    };
  }
}

/**
 * Bridges pgvector operations behind a port so embedding storage remains replaceable.
 */
export class PgVectorEmbeddingRepositoryService implements EmbeddingRepositoryPort {
  constructor(private readonly sqlClient: postgres.Sql<{}>) {}

  /**
   * Maintains one embedding per document to keep retrieval aligned with canonical document identity.
   */
  async upsertForDocument(
    documentId: string,
    symbol: string,
    runId: string,
    taskId: string,
    embedding: number[],
    content: string,
  ): Promise<void> {
    const vector = `[${embedding.join(",")}]`;
    await this.sqlClient`
      INSERT INTO embeddings (document_id, run_id, task_id, symbol, content, embedding)
      VALUES (${documentId}, ${runId}, ${taskId}, ${symbol.toUpperCase()}, ${content}, ${vector}::vector)
      ON CONFLICT (document_id)
      DO UPDATE SET
        run_id = EXCLUDED.run_id,
        task_id = EXCLUDED.task_id,
        symbol = EXCLUDED.symbol,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        updated_at = now();
    `;
  }
}

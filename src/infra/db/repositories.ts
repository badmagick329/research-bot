import { desc, eq, sql } from "drizzle-orm";
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
  async listBySymbol(symbol: string, limit: number): Promise<DocumentEntity[]> {
    const rows = await this.db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.symbol, symbol.toUpperCase()))
      .orderBy(desc(documentsTable.publishedAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
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
          metricValue: sql`excluded.metric_value`,
          confidence: sql`excluded.confidence`,
          rawPayload: sql`excluded.raw_payload`,
        },
      });
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
    await this.db.insert(filingsTable).values(filings).onConflictDoNothing();
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
  async latestBySymbol(symbol: string): Promise<ResearchSnapshotEntity | null> {
    const [row] = await this.db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.symbol, symbol.toUpperCase()))
      .orderBy(desc(snapshotsTable.createdAt))
      .limit(1);

    return row ?? null;
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
    embedding: number[],
    content: string,
  ): Promise<void> {
    const vector = `[${embedding.join(",")}]`;
    await this.sqlClient`
      INSERT INTO embeddings (document_id, symbol, content, embedding)
      VALUES (${documentId}, ${symbol.toUpperCase()}, ${content}, ${vector}::vector)
      ON CONFLICT (document_id)
      DO UPDATE SET
        symbol = EXCLUDED.symbol,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        updated_at = now();
    `;
  }
}

import { and, count, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type {
  ListRunsQuery,
  ListRunsResponse,
  RunDetail,
  RunDetailResponse,
  RunStageStatus,
  RunSummary,
} from "../../core/entities/opsConsole";
import type {
  ResearchSnapshotEntity,
  SnapshotDiagnostics,
} from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  EmbeddingRepositoryPort,
  FilingsRepositoryPort,
  MetricsRepositoryPort,
  RunsReadRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";
import {
  documentsTable,
  filingsTable,
  metricsTable,
  snapshotsTable,
} from "./schema";

type SnapshotRunRow = typeof snapshotsTable.$inferSelect;

type RunsCursor = {
  updatedAt: string;
  runId: string;
};

const toIsoTimestamp = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp value: ${String(value)}`);
  }

  return parsed.toISOString();
};

const MAX_RUNS_LIMIT = 100;
const DEFAULT_RUNS_LIMIT = 20;

const normalizeRunsLimit = (limit?: number): number => {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_RUNS_LIMIT;
  }

  if (limit < 1) {
    return 1;
  }

  if (limit > MAX_RUNS_LIMIT) {
    return MAX_RUNS_LIMIT;
  }

  return Math.trunc(limit);
};

const encodeRunsCursor = (cursor: RunsCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeRunsCursor = (cursor?: string): RunsCursor | undefined => {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as RunsCursor;

    if (
      !parsed ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.runId !== "string"
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
};

const toOptionalDiagnostics = (
  diagnostics: SnapshotDiagnostics,
): SnapshotDiagnostics | undefined =>
  Object.keys(diagnostics).length > 0 ? diagnostics : undefined;

const deriveRunStatus = (
  diagnostics?: SnapshotDiagnostics,
): RunSummary["status"] => {
  if (!diagnostics) {
    return "success";
  }

  const hasProviderFailures = (diagnostics.providerFailures ?? []).length > 0;
  const hasStageIssues = (diagnostics.stageIssues ?? []).length > 0;
  const isMetricsDegraded =
    diagnostics.metrics !== undefined && diagnostics.metrics.status !== "ok";

  if (hasProviderFailures || hasStageIssues || isMetricsDegraded) {
    return "degraded";
  }

  return "success";
};

const deriveRunStages = (
  diagnostics?: SnapshotDiagnostics,
): RunStageStatus[] => {
  const stageIssues = diagnostics?.stageIssues ?? [];

  const normalizeIssue = stageIssues.find(
    (issue) => issue.stage === "normalize",
  );
  const embedIssue = stageIssues.find((issue) => issue.stage === "embed");

  return [
    { stage: "ingest", status: "success" },
    {
      stage: "normalize",
      status: normalizeIssue ? "degraded" : "success",
    },
    {
      stage: "embed",
      status: embedIssue ? "degraded" : "success",
    },
    { stage: "synthesize", status: "success" },
  ];
};

const mapSnapshotToEntity = (row: SnapshotRunRow): ResearchSnapshotEntity => ({
  ...row,
  runId: row.runId ?? undefined,
  taskId: row.taskId ?? undefined,
  diagnostics: toOptionalDiagnostics(row.diagnostics),
});

const mapSnapshotToRunSummary = (
  row: SnapshotRunRow,
  evidence: { documents: number; metrics: number; filings: number },
): RunSummary => {
  const diagnostics = toOptionalDiagnostics(row.diagnostics);
  const identity = diagnostics?.identity;

  return {
    runId: row.runId ?? row.id,
    taskId: row.taskId ?? undefined,
    requestedSymbol: identity?.requestedSymbol ?? row.symbol,
    canonicalSymbol: identity?.canonicalSymbol ?? row.symbol,
    status: deriveRunStatus(diagnostics),
    diagnostics,
    evidence,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.createdAt),
  };
};

const mapSnapshotToRunDetail = (
  row: SnapshotRunRow,
  evidence: { documents: number; metrics: number; filings: number },
  createdAt: Date | string,
  updatedAt: Date | string,
): RunDetail => {
  const diagnostics = toOptionalDiagnostics(row.diagnostics);
  const identity = diagnostics?.identity;

  return {
    runId: row.runId ?? row.id,
    taskId: row.taskId ?? undefined,
    requestedSymbol: identity?.requestedSymbol ?? row.symbol,
    canonicalSymbol: identity?.canonicalSymbol ?? row.symbol,
    identity,
    status: deriveRunStatus(diagnostics),
    stages: deriveRunStages(diagnostics),
    diagnostics,
    evidence,
    latestSnapshot: mapSnapshotToEntity(row),
    createdAt: toIsoTimestamp(createdAt),
    updatedAt: toIsoTimestamp(updatedAt),
  };
};

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
    await this.db.insert(snapshotsTable).values({
      ...snapshot,
      diagnostics: snapshot.diagnostics ?? {},
    });
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
      diagnostics:
        row.diagnostics && Object.keys(row.diagnostics).length > 0
          ? row.diagnostics
          : undefined,
    };
  }
}

/**
 * Builds run-level read models from persisted snapshots so ops views can remain additive without new tables.
 */
export class PostgresRunsReadRepositoryService implements RunsReadRepositoryPort {
  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {}

  /**
   * Lists recent runs via stable keyset pagination so operators can poll without duplicate or skipped items.
   */
  async listRuns(query: ListRunsQuery): Promise<ListRunsResponse> {
    const normalizedSymbol = query.symbol?.trim().toUpperCase();
    const limit = normalizeRunsLimit(query.limit);
    const decodedCursor = decodeRunsCursor(query.cursor);
    const cursorDate = decodedCursor
      ? new Date(decodedCursor.updatedAt)
      : undefined;

    const whereClauses = [isNotNull(snapshotsTable.runId)];

    if (normalizedSymbol) {
      whereClauses.push(eq(snapshotsTable.symbol, normalizedSymbol));
    }

    if (decodedCursor && cursorDate && !Number.isNaN(cursorDate.getTime())) {
      whereClauses.push(
        or(
          sql`${snapshotsTable.createdAt} < ${cursorDate}`,
          and(
            eq(snapshotsTable.createdAt, cursorDate),
            sql`${snapshotsTable.runId} < ${decodedCursor.runId}`,
          ),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(snapshotsTable)
      .where(and(...whereClauses)!)
      .orderBy(desc(snapshotsTable.createdAt), desc(snapshotsTable.runId))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const runIds = pageRows
      .map((row) => row.runId)
      .filter((runId): runId is string => typeof runId === "string");

    const [documentCounts, metricCounts, filingCounts] = await Promise.all([
      runIds.length > 0
        ? this.db
            .select({ runId: documentsTable.runId, value: count() })
            .from(documentsTable)
            .where(inArray(documentsTable.runId, runIds))
            .groupBy(documentsTable.runId)
        : Promise.resolve([]),
      runIds.length > 0
        ? this.db
            .select({ runId: metricsTable.runId, value: count() })
            .from(metricsTable)
            .where(inArray(metricsTable.runId, runIds))
            .groupBy(metricsTable.runId)
        : Promise.resolve([]),
      runIds.length > 0
        ? this.db
            .select({ runId: filingsTable.runId, value: count() })
            .from(filingsTable)
            .where(inArray(filingsTable.runId, runIds))
            .groupBy(filingsTable.runId)
        : Promise.resolve([]),
    ]);

    const documentsByRunId = new Map(
      documentCounts
        .filter((entry) => entry.runId)
        .map((entry) => [entry.runId as string, entry.value]),
    );
    const metricsByRunId = new Map(
      metricCounts
        .filter((entry) => entry.runId)
        .map((entry) => [entry.runId as string, entry.value]),
    );
    const filingsByRunId = new Map(
      filingCounts
        .filter((entry) => entry.runId)
        .map((entry) => [entry.runId as string, entry.value]),
    );

    const items = pageRows.map((row) => {
      const runId = row.runId ?? row.id;
      return mapSnapshotToRunSummary(row, {
        documents: documentsByRunId.get(runId) ?? 0,
        metrics: metricsByRunId.get(runId) ?? 0,
        filings: filingsByRunId.get(runId) ?? 0,
      });
    });

    const tail = pageRows.at(pageRows.length - 1);
    const nextCursor =
      hasMore && tail
        ? encodeRunsCursor({
            updatedAt: toIsoTimestamp(tail.createdAt),
            runId: tail.runId ?? tail.id,
          })
        : undefined;

    return {
      items,
      nextCursor,
    };
  }

  /**
   * Projects one run detail from the latest snapshot so API reads remain deterministic under polling.
   */
  async getRunDetail(runId: string): Promise<RunDetailResponse | null> {
    const [
      latestSnapshot,
      aggregate,
      documentCountRows,
      metricCountRows,
      filingCountRows,
    ] = await Promise.all([
      this.db
        .select()
        .from(snapshotsTable)
        .where(eq(snapshotsTable.runId, runId))
        .orderBy(desc(snapshotsTable.createdAt))
        .limit(1),
      this.db
        .select({
          createdAt: sql<Date>`min(${snapshotsTable.createdAt})`,
          updatedAt: sql<Date>`max(${snapshotsTable.createdAt})`,
        })
        .from(snapshotsTable)
        .where(eq(snapshotsTable.runId, runId)),
      this.db
        .select({ value: count() })
        .from(documentsTable)
        .where(eq(documentsTable.runId, runId)),
      this.db
        .select({ value: count() })
        .from(metricsTable)
        .where(eq(metricsTable.runId, runId)),
      this.db
        .select({ value: count() })
        .from(filingsTable)
        .where(eq(filingsTable.runId, runId)),
    ]);

    const snapshot = latestSnapshot.at(0);
    if (!snapshot) {
      return null;
    }

    const aggregateRow = aggregate.at(0);
    const createdAt = aggregateRow?.createdAt ?? snapshot.createdAt;
    const updatedAt = aggregateRow?.updatedAt ?? snapshot.createdAt;

    return {
      run: mapSnapshotToRunDetail(
        snapshot,
        {
          documents: documentCountRows.at(0)?.value ?? 0,
          metrics: metricCountRows.at(0)?.value ?? 0,
          filings: filingCountRows.at(0)?.value ?? 0,
        },
        createdAt,
        updatedAt,
      ),
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

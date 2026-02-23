import type {
  ListRunsQuery,
  LatestSnapshotResponse,
  ListRunsResponse,
  QueueCountsResponse,
  RunSummary,
  RunDetailResponse,
} from "../../core/entities/opsConsole";
import type { RunQueryUseCasePort } from "../../core/ports/inboundPorts";
import type {
  QueueCountsReadPort,
  QueueRunReadPort,
  RunsReadRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";

/**
 * Centralizes read-only ops console queries so transports share one consistent projection policy.
 */
export class RunQueryService implements RunQueryUseCasePort {
  constructor(
    private readonly queueReads: QueueCountsReadPort & QueueRunReadPort,
    private readonly snapshots: SnapshotRepositoryPort,
    private readonly runsReadRepository: RunsReadRepositoryPort,
  ) {}

  /**
   * Samples queue depth through the queue port so API and CLI avoid direct queue-adapter coupling.
   */
  async getQueueCounts(): Promise<QueueCountsResponse> {
    return this.queueReads.getQueueCountsSampled();
  }

  /**
   * Returns the latest snapshot for an input symbol while keeping symbol normalization in one place.
   */
  async getLatestSnapshot(
    symbol: string,
  ): Promise<LatestSnapshotResponse | null> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const snapshot = await this.snapshots.latestBySymbol(normalizedSymbol);

    if (!snapshot) {
      return null;
    }

    return { snapshot };
  }

  /**
   * Delegates run listing to read-model repository so pagination semantics remain infrastructure-owned.
   */
  async listRuns(query: ListRunsQuery): Promise<ListRunsResponse> {
    const persisted = await this.runsReadRepository.listRuns(query);
    const normalizedSymbol = query.symbol?.trim().toUpperCase();

    if (!normalizedSymbol) {
      return persisted;
    }

    const queued =
      await this.queueReads.getLatestRunStateBySymbol(normalizedSymbol);
    if (!queued) {
      return persisted;
    }

    const queuedSummary: RunSummary = {
      runId: queued.runId,
      taskId: queued.taskId,
      requestedSymbol: queued.requestedSymbol,
      canonicalSymbol: queued.canonicalSymbol,
      status: queued.status,
      evidence: {
        documents: 0,
        metrics: 0,
        filings: 0,
      },
      createdAt: queued.requestedAt,
      updatedAt: queued.updatedAt,
    };

    const alreadyPresent = persisted.items.some(
      (item) => item.runId === queuedSummary.runId,
    );

    if (alreadyPresent) {
      return persisted;
    }

    return {
      ...persisted,
      items: [queuedSummary, ...persisted.items],
    };
  }

  /**
   * Exposes one run projection by id without leaking storage details to transport handlers.
   */
  async getRunDetail(runId: string): Promise<RunDetailResponse | null> {
    const persisted = await this.runsReadRepository.getRunDetail(runId);
    if (persisted) {
      return persisted;
    }

    const queued = await this.queueReads.getRunState(runId);
    if (!queued) {
      return null;
    }

    return {
      run: {
        runId: queued.runId,
        taskId: queued.taskId,
        requestedSymbol: queued.requestedSymbol,
        canonicalSymbol: queued.canonicalSymbol,
        identity: queued.identity,
        status: queued.status,
        stages: queued.stages,
        evidence: {
          documents: 0,
          metrics: 0,
          filings: 0,
        },
        createdAt: queued.requestedAt,
        updatedAt: queued.updatedAt,
      },
    };
  }
}

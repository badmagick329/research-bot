import type {
  ListRunsQuery,
  LatestSnapshotResponse,
  ListRunsResponse,
  QueueCountsResponse,
  RunDetailResponse,
} from "../../core/entities/opsConsole";
import type { RunQueryUseCasePort } from "../../core/ports/inboundPorts";
import type {
  QueueCountsReadPort,
  RunsReadRepositoryPort,
  SnapshotRepositoryPort,
} from "../../core/ports/outboundPorts";

/**
 * Centralizes read-only ops console queries so transports share one consistent projection policy.
 */
export class RunQueryService implements RunQueryUseCasePort {
  constructor(
    private readonly queueCounts: QueueCountsReadPort,
    private readonly snapshots: SnapshotRepositoryPort,
    private readonly runsReadRepository: RunsReadRepositoryPort,
  ) {}

  /**
   * Samples queue depth through the queue port so API and CLI avoid direct queue-adapter coupling.
   */
  async getQueueCounts(): Promise<QueueCountsResponse> {
    return this.queueCounts.getQueueCountsSampled();
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
    return this.runsReadRepository.listRuns(query);
  }

  /**
   * Exposes one run projection by id without leaking storage details to transport handlers.
   */
  async getRunDetail(runId: string): Promise<RunDetailResponse | null> {
    return this.runsReadRepository.getRunDetail(runId);
  }
}

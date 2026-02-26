import type {
  ApiErrorResponse,
  EnqueueRunRequest,
  EnqueueRunResponse,
  LatestSnapshotResponse,
  ListRunsQuery,
  ListRunsResponse,
  QueueCountsResponse,
  RefreshThesisResponse,
  RunDetailResponse,
} from "@contracts/opsConsole";
import { getWebEnv } from "./env";

/**
 * Captures request failure details so UI state can distinguish contract errors from transport failures.
 */
export class OpsConsoleApiError extends Error {
  public readonly status: number;

  public readonly code: ApiErrorResponse["error"]["code"];

  public readonly retryable: boolean;

  /**
   * Stores API error metadata so route-level views can render actionable error states.
   */
  public constructor(status: number, error: ApiErrorResponse["error"]) {
    super(error.message);
    this.name = "OpsConsoleApiError";
    this.status = status;
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

/**
 * Provides one typed client boundary so route code stays focused on behavior, not HTTP details.
 */
export function createOpsConsoleApiClient() {
  return {
    enqueueRun,
    refreshThesis,
    getQueueCounts,
    getLatestSnapshot,
    listRuns,
    getRunDetail,
  };
}

/**
 * Sends enqueue requests through a contract-aware helper so result metadata stays strongly typed.
 */
async function enqueueRun(
  payload: EnqueueRunRequest,
): Promise<EnqueueRunResponse> {
  return request<EnqueueRunResponse>("/api/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Triggers synthesize-only thesis refresh so operators can rerun thesis generation without ingesting providers again.
 */
async function refreshThesis(
  symbol: string,
  runId?: string,
): Promise<RefreshThesisResponse> {
  const normalized = symbol.trim().toUpperCase();
  const encoded = encodeURIComponent(normalized);

  return request<RefreshThesisResponse>(
    `/api/snapshots/${encoded}/refresh-thesis`,
    {
      method: "POST",
      body: JSON.stringify(runId ? { runId } : {}),
    },
  );
}

/**
 * Fetches queue counts for all stages so monitor screens can read one stable response shape.
 */
async function getQueueCounts(): Promise<QueueCountsResponse> {
  return request<QueueCountsResponse>("/api/queue/counts");
}

/**
 * Loads latest snapshot by symbol so snapshot screens can stay symbol-centric and idempotent.
 */
async function getLatestSnapshot(
  symbol: string,
): Promise<LatestSnapshotResponse> {
  const normalized = symbol.trim().toUpperCase();
  const encoded = encodeURIComponent(normalized);
  return request<LatestSnapshotResponse>(`/api/snapshots/${encoded}/latest`);
}

/**
 * Lists recent runs with optional filtering so polling views can preserve server pagination semantics.
 */
async function listRuns(query: ListRunsQuery = {}): Promise<ListRunsResponse> {
  const params = new URLSearchParams();
  if (query.symbol) {
    params.set("symbol", query.symbol);
  }
  if (typeof query.limit === "number") {
    params.set("limit", String(query.limit));
  }
  if (query.cursor) {
    params.set("cursor", query.cursor);
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<ListRunsResponse>(`/api/runs${suffix}`);
}

/**
 * Fetches run detail by runId so stage and diagnostics rendering can share one canonical source.
 */
async function getRunDetail(runId: string): Promise<RunDetailResponse> {
  const encoded = encodeURIComponent(runId.trim());
  return request<RunDetailResponse>(`/api/runs/${encoded}`);
}

/**
 * Performs JSON HTTP calls with uniform error mapping so client code has predictable failure semantics.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiBaseUrl } = getWebEnv();
  const url = `${apiBaseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  return (await response.json()) as T;
}

/**
 * Normalizes non-2xx responses into one typed error so UI error handling remains simple and explicit.
 */
async function throwApiError(response: Response): Promise<never> {
  let parsed: unknown;

  try {
    parsed = await response.json();
  } catch {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  if (isApiErrorEnvelope(parsed)) {
    throw new OpsConsoleApiError(response.status, parsed.error);
  }

  throw new Error(`Request failed with status ${response.status}.`);
}

/**
 * Narrows unknown payloads to API error contracts so thrown errors preserve backend semantics.
 */
function isApiErrorEnvelope(value: unknown): value is ApiErrorResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ApiErrorResponse>;
  return (
    typeof candidate.error?.code === "string" &&
    typeof candidate.error.message === "string" &&
    typeof candidate.error.retryable === "boolean"
  );
}

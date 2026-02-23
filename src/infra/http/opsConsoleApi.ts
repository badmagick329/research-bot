import type {
  ApiErrorResponse,
  EnqueueRunRequest,
  EnqueueRunResponse,
  LatestSnapshotResponse,
  ListRunsQuery,
  ListRunsResponse,
  QueueCountsResponse,
  RunDetailResponse,
} from "../../core/entities/opsConsole";

type ErrorCode = ApiErrorResponse["error"]["code"];

type OpsConsoleApiDeps = {
  enqueueRun(request: EnqueueRunRequest): Promise<EnqueueRunResponse>;
  getQueueCounts(): Promise<QueueCountsResponse>;
  getLatestSnapshot(symbol: string): Promise<LatestSnapshotResponse | null>;
  listRuns(query: ListRunsQuery): Promise<ListRunsResponse>;
  getRunDetail(runId: string): Promise<RunDetailResponse | null>;
};

type ApiFailure = {
  status: number;
  body: ApiErrorResponse;
};

/**
 * Creates the ops-console HTTP handler so transport concerns stay isolated from application services.
 */
export const createOpsConsoleApiHandler =
  (deps: OpsConsoleApiDeps) =>
  async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === "POST" && pathname === "/api/runs") {
        const payload = await parseEnqueueRequest(request);
        const response = await deps.enqueueRun(payload);
        return json(202, response);
      }

      if (request.method === "GET" && pathname === "/api/queue/counts") {
        const response = await deps.getQueueCounts();
        return json(200, response);
      }

      if (
        request.method === "GET" &&
        pathname.startsWith("/api/snapshots/") &&
        pathname.endsWith("/latest")
      ) {
        const symbol = parseSymbolFromSnapshotPath(pathname);
        const response = await deps.getLatestSnapshot(symbol);

        if (!response) {
          throw notFound("Snapshot not found for requested symbol.");
        }

        return json(200, response);
      }

      if (request.method === "GET" && pathname === "/api/runs") {
        const query = parseListRunsQuery(url.searchParams);
        const response = await deps.listRuns(query);
        return json(200, response);
      }

      if (request.method === "GET" && pathname.startsWith("/api/runs/")) {
        const runId = parseRunIdFromPath(pathname);
        const response = await deps.getRunDetail(runId);

        if (!response) {
          throw notFound("Run not found for requested runId.");
        }

        return json(200, response);
      }

      return json(404, {
        error: {
          code: "not_found",
          message: "Route not found.",
          retryable: false,
        },
      } satisfies ApiErrorResponse);
    } catch (error) {
      const failure = mapErrorToApiFailure(error);
      return json(failure.status, failure.body);
    }
  };

/**
 * Parses enqueue payload with strict shape checks to keep malformed requests out of use-case code.
 */
const parseEnqueueRequest = async (
  request: Request,
): Promise<EnqueueRunRequest> => {
  let parsed: unknown;

  try {
    parsed = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw badRequest("Request body must be a JSON object.");
  }

  const candidate = parsed as Record<string, unknown>;
  const symbol =
    typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";

  if (!symbol) {
    throw badRequest(
      "Field 'symbol' is required and must be a non-empty string.",
    );
  }

  if (
    typeof candidate.force !== "undefined" &&
    typeof candidate.force !== "boolean"
  ) {
    throw badRequest("Field 'force' must be a boolean when provided.");
  }

  return {
    symbol,
    force: candidate.force as boolean | undefined,
  };
};

/**
 * Parses list-runs query params with strict validation so pagination semantics remain predictable.
 */
const parseListRunsQuery = (search: URLSearchParams): ListRunsQuery => {
  const query: ListRunsQuery = {};

  const symbol = search.get("symbol");
  if (symbol !== null) {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) {
      throw badRequest("Query parameter 'symbol' must be a non-empty string.");
    }
    query.symbol = normalized;
  }

  const limit = search.get("limit");
  if (limit !== null) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw badRequest(
        "Query parameter 'limit' must be a positive integer when provided.",
      );
    }
    query.limit = parsedLimit;
  }

  const cursor = search.get("cursor");
  if (cursor !== null) {
    if (!isValidRunsCursor(cursor)) {
      throw badRequest("Query parameter 'cursor' is invalid.");
    }
    query.cursor = cursor;
  }

  return query;
};

/**
 * Verifies cursor shape before repository call so invalid cursors fail fast with explicit client feedback.
 */
const isValidRunsCursor = (cursor: string): boolean => {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { updatedAt?: unknown; runId?: unknown };

    return (
      typeof decoded.updatedAt === "string" &&
      Number.isFinite(Date.parse(decoded.updatedAt)) &&
      typeof decoded.runId === "string" &&
      decoded.runId.trim().length > 0
    );
  } catch {
    return false;
  }
};

/**
 * Extracts snapshot symbol from path segments so route parsing remains explicit and testable.
 */
const parseSymbolFromSnapshotPath = (pathname: string): string => {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length !== 4 ||
    segments[0] !== "api" ||
    segments[1] !== "snapshots" ||
    segments[3] !== "latest"
  ) {
    throw notFound("Route not found.");
  }

  const symbol = decodeURIComponent(segments[2] ?? "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    throw badRequest("Path parameter 'symbol' must be a non-empty string.");
  }

  return symbol;
};

/**
 * Extracts run id from route path to keep endpoint parsing strict and deterministic.
 */
const parseRunIdFromPath = (pathname: string): string => {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length !== 3 ||
    segments[0] !== "api" ||
    segments[1] !== "runs"
  ) {
    throw notFound("Route not found.");
  }

  const runId = decodeURIComponent(segments[2] ?? "").trim();
  if (!runId) {
    throw badRequest("Path parameter 'runId' must be a non-empty string.");
  }

  return runId;
};

/**
 * Converts domain/application errors into contract-stable API envelopes for clients.
 */
const mapErrorToApiFailure = (error: unknown): ApiFailure => {
  if (isApiFailure(error)) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message || "Internal server error.";

    if (message.includes("Company resolution failed")) {
      return {
        status: 400,
        body: {
          error: {
            code: "bad_request",
            message,
            retryable: false,
          },
        },
      };
    }

    return {
      status: 500,
      body: {
        error: {
          code: "internal_error",
          message,
          retryable: false,
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Internal server error.",
        retryable: false,
      },
    },
  };
};

/**
 * Builds a bad-request contract error to avoid duplicated envelope literals across validators.
 */
const badRequest = (message: string): ApiFailure =>
  failure(400, "bad_request", message, false);

/**
 * Builds a not-found contract error so missing resources share one response shape.
 */
const notFound = (message: string): ApiFailure =>
  failure(404, "not_found", message, false);

/**
 * Creates one API failure object so status and envelope stay synchronized.
 */
const failure = (
  status: number,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): ApiFailure => ({
  status,
  body: {
    error: {
      code,
      message,
      retryable,
    },
  },
});

/**
 * Narrows unknown errors to API failures produced by transport validators and route helpers.
 */
const isApiFailure = (value: unknown): value is ApiFailure => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ApiFailure>;
  return (
    typeof candidate.status === "number" &&
    typeof candidate.body?.error?.code === "string" &&
    typeof candidate.body.error.message === "string" &&
    typeof candidate.body.error.retryable === "boolean"
  );
};

/**
 * Produces JSON responses with consistent content type across all endpoints.
 */
const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

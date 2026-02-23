import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunDetail } from "@contracts/opsConsole";
import type { SnapshotDiagnostics } from "@contracts/research";
import { DiagnosticChips } from "../components/DiagnosticChips";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import {
  OpsConsoleApiError,
  createOpsConsoleApiClient,
} from "../lib/apiClient";
import { useSearchParams } from "react-router-dom";

const apiClient = createOpsConsoleApiClient();
const TERMINAL_STATUSES = new Set(["success", "degraded", "failed"]);

/**
 * Polls run detail by runId so operators can inspect stage progression and diagnostics from one screen.
 */
export function RunMonitorRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runIdFromQuery = searchParams.get("runId")?.trim() ?? "";
  const [runIdInput, setRunIdInput] = useState(runIdFromQuery);

  useEffect(() => {
    setRunIdInput(runIdFromQuery);
  }, [runIdFromQuery]);

  const runDetailQuery = useQuery({
    queryKey: ["run-detail", runIdFromQuery],
    queryFn: async () => apiClient.getRunDetail(runIdFromQuery),
    enabled: runIdFromQuery.length > 0,
  });

  useEffect(() => {
    if (!runIdFromQuery) {
      return;
    }

    if (isTerminalRunStatus(runDetailQuery.data?.run.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void runDetailQuery.refetch();
    }, 5_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [runIdFromQuery, runDetailQuery]);

  const diagnosticsItems = useMemo(() => {
    return mapDiagnosticsToChips(runDetailQuery.data?.run.diagnostics);
  }, [runDetailQuery.data?.run.diagnostics]);

  return (
    <section className="space-y-6 rounded-xl border border-slate-800 bg-slate-900 p-6">
      <header>
        <h2 className="text-base font-semibold">Run Monitor</h2>
        <p className="mt-2 text-sm text-slate-300">
          Enter a run ID to poll stage status and diagnostics every 5 seconds.
        </p>
      </header>

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const nextRunId = runIdInput.trim();
          if (!nextRunId) {
            setSearchParams({});
            return;
          }

          setSearchParams({ runId: nextRunId });
        }}
      >
        <label className="w-full sm:max-w-xl">
          <span className="mb-1 block text-sm text-slate-200">runId</span>
          <input
            value={runIdInput}
            onChange={(event) => {
              setRunIdInput(event.target.value);
            }}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-blue-500/60 placeholder:text-slate-500 focus:ring"
            placeholder="Paste runId"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          Load run
        </button>
      </form>

      {!runIdFromQuery ? (
        <EmptyState
          title="No run selected"
          message="Set a runId in the field above to start monitoring."
        />
      ) : null}

      {runIdFromQuery && runDetailQuery.isLoading ? (
        <LoadingState message="Loading run detail..." />
      ) : null}

      {runIdFromQuery && runDetailQuery.error ? (
        <RunMonitorErrorState error={runDetailQuery.error} />
      ) : null}

      {runDetailQuery.data ? (
        <article className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-5">
          <header className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Run {runDetailQuery.data.run.runId}
            </h3>
            <StatusBadge status={runDetailQuery.data.run.status} />
            <span className="text-xs text-slate-400">
              {runDetailQuery.isFetching ? "Refreshing..." : "Up to date"}
            </span>
          </header>

          <dl className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">Requested symbol</dt>
              <dd>{runDetailQuery.data.run.requestedSymbol}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Canonical symbol</dt>
              <dd>{runDetailQuery.data.run.canonicalSymbol}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Created</dt>
              <dd>{formatUnknownDate(runDetailQuery.data.run.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Updated</dt>
              <dd>{formatUnknownDate(runDetailQuery.data.run.updatedAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Last polled</dt>
              <dd>
                {new Date(runDetailQuery.dataUpdatedAt).toLocaleTimeString()}
              </dd>
            </div>
          </dl>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-100">Stages</h4>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {runDetailQuery.data.run.stages.map((stage) => (
                <li
                  key={stage.stage}
                  className="rounded-lg border border-slate-800 bg-slate-900 p-3"
                >
                  <p className="text-xs uppercase tracking-wide text-slate-400">
                    {stage.stage}
                  </p>
                  <p
                    className={`mt-1 text-sm font-medium ${stageStatusClassName(stage.status)}`}
                  >
                    {stage.status}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-100">Evidence</h4>
            <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs text-slate-400">Documents</p>
                <p className="mt-1 font-medium">
                  {runDetailQuery.data.run.evidence.documents}
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs text-slate-400">Metrics</p>
                <p className="mt-1 font-medium">
                  {runDetailQuery.data.run.evidence.metrics}
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                <p className="text-xs text-slate-400">Filings</p>
                <p className="mt-1 font-medium">
                  {runDetailQuery.data.run.evidence.filings}
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-100">
              Diagnostics
            </h4>
            <DiagnosticChips items={diagnosticsItems} />
          </section>
        </article>
      ) : null}
    </section>
  );
}

type RunMonitorErrorStateProps = {
  error: Error;
};

/**
 * Converts typed API failures into route-specific empty vs error states so operators get accurate context.
 */
function RunMonitorErrorState({ error }: RunMonitorErrorStateProps) {
  if (error instanceof OpsConsoleApiError && error.status === 404) {
    return (
      <EmptyState
        title="Run not found"
        message="No run detail exists for this runId yet."
      />
    );
  }

  if (error instanceof OpsConsoleApiError) {
    return <ErrorState title="Unable to load run" message={error.message} />;
  }

  return (
    <ErrorState
      title="Unable to load run"
      message="An unexpected error occurred while loading run detail."
    />
  );
}

function isTerminalRunStatus(status: RunDetail["status"] | undefined): boolean {
  if (!status) {
    return false;
  }

  return TERMINAL_STATUSES.has(status);
}

function stageStatusClassName(status: string): string {
  switch (status) {
    case "success":
      return "text-emerald-300";
    case "degraded":
      return "text-amber-300";
    case "failed":
      return "text-rose-300";
    case "running":
      return "text-blue-300";
    case "queued":
      return "text-indigo-300";
    default:
      return "text-slate-300";
  }
}

function mapDiagnosticsToChips(
  diagnostics: SnapshotDiagnostics | undefined,
): string[] {
  if (!diagnostics) {
    return [];
  }

  const items: string[] = [];
  if (diagnostics.metrics && diagnostics.metrics.status !== "ok") {
    items.push(
      `metrics:${diagnostics.metrics.provider}:${diagnostics.metrics.status}`,
    );
  }

  for (const failure of diagnostics.providerFailures ?? []) {
    items.push(`${failure.source}:${failure.provider}:${failure.status}`);
  }

  for (const issue of diagnostics.stageIssues ?? []) {
    items.push(`${issue.stage}:${issue.reason}`);
  }

  return items;
}

function formatUnknownDate(value: string | Date): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

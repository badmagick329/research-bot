import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ResearchSnapshotEntity,
  SnapshotDiagnostics,
} from "@contracts/research";
import { DiagnosticChips } from "../components/DiagnosticChips";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import {
  OpsConsoleApiError,
  createOpsConsoleApiClient,
} from "../lib/apiClient";

const apiClient = createOpsConsoleApiClient();

/**
 * Loads the latest snapshot by symbol so operators can inspect identity, quality alerts, and synthesized output.
 */
export function SnapshotRoute() {
  const [symbolInput, setSymbolInput] = useState("");
  const [submittedSymbol, setSubmittedSymbol] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const snapshotQuery = useQuery({
    queryKey: ["latest-snapshot", submittedSymbol],
    queryFn: async () => apiClient.getLatestSnapshot(submittedSymbol),
    enabled: submittedSymbol.length > 0,
  });

  const qualityAlerts = useMemo(() => {
    return mapDiagnosticsToChips(snapshotQuery.data?.snapshot.diagnostics);
  }, [snapshotQuery.data?.snapshot.diagnostics]);

  return (
    <section className="space-y-6 rounded-xl border border-slate-800 bg-slate-900 p-6">
      <header>
        <h2 className="text-base font-semibold">Latest Snapshot</h2>
        <p className="mt-2 text-sm text-slate-300">
          Look up a symbol to inspect the latest synthesized snapshot and
          diagnostics.
        </p>
      </header>

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const symbol = symbolInput.trim();

          if (!symbol) {
            setValidationMessage("Enter a symbol or company alias.");
            return;
          }

          setValidationMessage(null);
          setSubmittedSymbol(symbol);
        }}
      >
        <label className="w-full sm:max-w-md">
          <span className="mb-1 block text-sm text-slate-200">Symbol</span>
          <input
            value={symbolInput}
            onChange={(event) => {
              setSymbolInput(event.target.value);
              if (validationMessage) {
                setValidationMessage(null);
              }
            }}
            placeholder="AAPL"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-blue-500/60 placeholder:text-slate-500 focus:ring"
          />
        </label>

        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          Load snapshot
        </button>
      </form>

      {validationMessage ? (
        <ErrorState title="Validation error" message={validationMessage} />
      ) : null}

      {!submittedSymbol ? (
        <EmptyState
          title="No symbol selected"
          message="Submit a symbol to load its latest snapshot."
        />
      ) : null}

      {submittedSymbol && snapshotQuery.isLoading ? (
        <LoadingState message="Loading latest snapshot..." />
      ) : null}

      {submittedSymbol && snapshotQuery.error ? (
        <SnapshotErrorState error={snapshotQuery.error} />
      ) : null}

      {snapshotQuery.data ? (
        <SnapshotContent
          snapshot={snapshotQuery.data.snapshot}
          qualityAlerts={qualityAlerts}
        />
      ) : null}
    </section>
  );
}

type SnapshotErrorStateProps = {
  error: Error;
};

/**
 * Maps API response failures into empty-state vs actionable-error UX so missing symbols do not look like runtime faults.
 */
function SnapshotErrorState({ error }: SnapshotErrorStateProps) {
  if (error instanceof OpsConsoleApiError && error.status === 404) {
    return (
      <EmptyState
        title="Snapshot not found"
        message="No snapshot exists for this symbol yet."
      />
    );
  }

  if (error instanceof OpsConsoleApiError) {
    return (
      <ErrorState title="Unable to load snapshot" message={error.message} />
    );
  }

  return (
    <ErrorState
      title="Unable to load snapshot"
      message="An unexpected error occurred while loading snapshot data."
    />
  );
}

type SnapshotContentProps = {
  snapshot: ResearchSnapshotEntity;
  qualityAlerts: string[];
};

/**
 * Presents synthesized output and diagnostics in one place so operators can assess quality before downstream use.
 */
function SnapshotContent({ snapshot, qualityAlerts }: SnapshotContentProps) {
  const identity = snapshot.diagnostics?.identity;

  return (
    <article className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-5">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold text-slate-100">
          {snapshot.symbol}
        </h3>
        <p className="text-xs text-slate-400">
          Created {formatUnknownDate(snapshot.createdAt)}
        </p>
      </header>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-100">
          Resolved identity
        </h4>
        {identity ? (
          <dl className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">Requested symbol</dt>
              <dd>{identity.requestedSymbol}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Canonical symbol</dt>
              <dd>{identity.canonicalSymbol}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Company</dt>
              <dd>{identity.companyName}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Resolution source</dt>
              <dd>{identity.resolutionSource}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-slate-300">
            No identity diagnostics found.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-100">
          Data quality alerts
        </h4>
        <DiagnosticChips items={qualityAlerts} />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-100">Thesis</h4>
        <p className="text-sm text-slate-200">{snapshot.thesis}</p>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-100">Risks</h4>
          {snapshot.risks.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-200">
              {snapshot.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-300">No risks listed.</p>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-100">Catalysts</h4>
          {snapshot.catalysts.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-200">
              {snapshot.catalysts.map((catalyst) => (
                <li key={catalyst}>{catalyst}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-300">No catalysts listed.</p>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-100">Sources</h4>
        {snapshot.sources.length > 0 ? (
          <ul className="space-y-2">
            {snapshot.sources.map((source, index) => (
              <li
                key={`${source.provider}-${source.url ?? source.title ?? index}`}
                className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm text-slate-200"
              >
                <p className="font-medium">{source.provider}</p>
                {source.title ? (
                  <p className="text-slate-300">{source.title}</p>
                ) : null}
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-300 underline underline-offset-2 hover:text-blue-200"
                  >
                    {source.url}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-300">No sources recorded.</p>
        )}
      </section>
    </article>
  );
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

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  InvestorViewV2,
  ResearchSnapshotEntity,
  SnapshotDiagnostics,
} from "@contracts/research";
import { Link } from "react-router-dom";
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
  const [refreshPollingActive, setRefreshPollingActive] = useState(false);
  const [refreshBaselineCreatedAt, setRefreshBaselineCreatedAt] = useState<
    string | null
  >(null);

  const snapshotQuery = useQuery({
    queryKey: ["latest-snapshot", submittedSymbol],
    queryFn: async () => apiClient.getLatestSnapshot(submittedSymbol),
    enabled: submittedSymbol.length > 0,
  });

  const qualityAlerts = useMemo(() => {
    return mapDiagnosticsToChips(snapshotQuery.data?.snapshot.diagnostics);
  }, [snapshotQuery.data?.snapshot.diagnostics]);

  const refreshThesisMutation = useMutation({
    mutationFn: async () => {
      if (!snapshotQuery.data) {
        throw new Error("Load a snapshot before refreshing thesis.");
      }

      setRefreshBaselineCreatedAt(
        new Date(snapshotQuery.data.snapshot.createdAt).toISOString(),
      );
      return apiClient.refreshThesis(
        snapshotQuery.data.snapshot.symbol,
        snapshotQuery.data.snapshot.runId,
      );
    },
    onSuccess: () => {
      setRefreshPollingActive(true);
    },
  });

  useEffect(() => {
    if (!refreshPollingActive || !submittedSymbol) {
      return;
    }

    const interval = setInterval(() => {
      void snapshotQuery.refetch();
    }, 3000);

    const timeout = setTimeout(() => {
      setRefreshPollingActive(false);
    }, 60000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [refreshPollingActive, submittedSymbol, snapshotQuery]);

  useEffect(() => {
    if (!refreshPollingActive || !refreshBaselineCreatedAt || !snapshotQuery.data) {
      return;
    }

    const baselineMs = new Date(refreshBaselineCreatedAt).getTime();
    const currentMs = new Date(snapshotQuery.data.snapshot.createdAt).getTime();
    if (Number.isFinite(baselineMs) && Number.isFinite(currentMs) && currentMs > baselineMs) {
      setRefreshPollingActive(false);
    }
  }, [
    refreshBaselineCreatedAt,
    refreshPollingActive,
    snapshotQuery.data,
  ]);

  const refreshErrorMessage = useMemo(() => {
    if (!refreshThesisMutation.error) {
      return null;
    }

    if (refreshThesisMutation.error instanceof OpsConsoleApiError) {
      if (refreshThesisMutation.error.code === "upstream_error") {
        return `${refreshThesisMutation.error.message}${refreshThesisMutation.error.retryable ? " Retry in a moment." : ""}`;
      }
      return refreshThesisMutation.error.message;
    }

    return "Unable to refresh thesis.";
  }, [refreshThesisMutation.error]);

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
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                refreshThesisMutation.reset();
                void refreshThesisMutation.mutateAsync();
              }}
              disabled={refreshThesisMutation.isPending}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700"
            >
              {refreshThesisMutation.isPending
                ? "Refreshing thesis..."
                : "Refresh thesis only"}
            </button>
            <p className="text-xs text-slate-400">
              Re-runs synthesize stage only using stored evidence for this run.
            </p>
            {refreshPollingActive ? (
              <p className="text-xs text-slate-300">
                Waiting for new snapshot...
              </p>
            ) : null}
          </div>

          {refreshErrorMessage ? (
            <ErrorState title="Thesis refresh failed" message={refreshErrorMessage} />
          ) : null}

          {refreshThesisMutation.data ? (
            <section className="rounded-xl border border-emerald-700/60 bg-emerald-900/20 p-4">
              <h3 className="text-sm font-semibold text-emerald-200">
                Thesis refresh accepted
              </h3>
              <p className="mt-2 text-sm text-emerald-100">
                Run queued at {formatUnknownDate(refreshThesisMutation.data.enqueuedAt)}.
              </p>
              <div className="mt-3">
                <Link
                  to={`/runs?runId=${encodeURIComponent(refreshThesisMutation.data.runId)}`}
                  className="text-sm font-medium text-emerald-200 underline underline-offset-2 hover:text-emerald-100"
                >
                  Open run monitor
                </Link>
              </div>
            </section>
          ) : null}

          <SnapshotContent
            snapshot={snapshotQuery.data.snapshot}
            qualityAlerts={qualityAlerts}
          />
        </div>
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
    if (error.code === "upstream_error") {
      return (
        <ErrorState
          title="Upstream dependency unavailable"
          message={`${error.message}${error.retryable ? " Retry in a moment." : ""}`}
        />
      );
    }

    if (error.code === "conflict") {
      return (
        <ErrorState title="Snapshot lookup conflict" message={error.message} />
      );
    }

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
  const investorView = snapshot.investorViewV2;

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

      {investorView ? <InvestorViewSection investorView={investorView} /> : null}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-100">Thesis</h4>
        <ThesisMarkdown content={snapshot.thesis} />
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

type InvestorViewSectionProps = {
  investorView: InvestorViewV2;
};

/**
 * Renders investor-facing structured output first so users can evaluate thesis quality without parsing diagnostics internals.
 */
function InvestorViewSection({ investorView }: InvestorViewSectionProps) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h4 className="text-sm font-semibold text-slate-100">Investor View (v2)</h4>
      <dl className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
        <div>
          <dt className="text-slate-400">Thesis type</dt>
          <dd>{investorView.thesisType}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Decision</dt>
          <dd>
            {formatDecisionLabel(investorView.action.decision)} ({investorView.action.positionSizing})
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Horizon</dt>
          <dd>{investorView.horizon.bucket}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Confidence</dt>
          <dd>
            D:{investorView.confidence.dataConfidence} T:{investorView.confidence.thesisConfidence} Ti:
            {investorView.confidence.timingConfidence}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-slate-200">{investorView.summary.oneLineThesis}</p>
      {investorView.keyKpis.length > 0 ? (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Key KPIs</h5>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">
            {investorView.keyKpis.slice(0, 6).map((kpi) => (
              <li key={kpi.name}>
                {kpi.name}: {kpi.value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {investorView.falsification.length > 0 ? (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Falsification</h5>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">
            {investorView.falsification.map((item, index) => (
              <li key={`${item.condition}-${index}`}>
                {item.condition} {"->"} {item.actionIfHit}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

type ThesisMarkdownProps = {
  content: string;
};

/**
 * Renders synthesized thesis markdown safely so structured sections stay readable without exposing raw HTML.
 */
function ThesisMarkdown({ content }: ThesisMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        h1: ({ children }) => (
          <h5 className="mt-4 text-base font-semibold text-slate-100 first:mt-0">
            {children}
          </h5>
        ),
        h2: ({ children }) => (
          <h5 className="mt-4 text-base font-semibold text-slate-100 first:mt-0">
            {children}
          </h5>
        ),
        h3: ({ children }) => (
          <h6 className="mt-3 text-sm font-semibold text-slate-100 first:mt-0">
            {children}
          </h6>
        ),
        p: ({ children }) => (
          <p className="mt-2 text-sm leading-6 text-slate-200 first:mt-0">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200 first:mt-0">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-200 first:mt-0">
            {children}
          </ol>
        ),
        li: ({ children }) => <li>{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold text-slate-100">{children}</strong>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-blue-300 underline underline-offset-2 hover:text-blue-200"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
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

  if (diagnostics.kpiCoverage) {
    items.push(`kpi_coverage:${diagnostics.kpiCoverage.mode}`);
    items.push(
      `kpi_core:${diagnostics.kpiCoverage.coreCurrentCount + diagnostics.kpiCoverage.coreCarriedCount}/${diagnostics.kpiCoverage.coreRequiredCount}`,
    );
  }

  return items;
}

function formatDecisionLabel(value: InvestorViewV2["action"]["decision"]): string {
  if (value === "watch_low_quality") {
    return "watch (low quality)";
  }

  return value;
}

function formatUnknownDate(value: string | Date): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toLocaleString();
}

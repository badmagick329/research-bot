import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ErrorState } from "../components/states/ErrorState";
import {
  OpsConsoleApiError,
  createOpsConsoleApiClient,
} from "../lib/apiClient";

const apiClient = createOpsConsoleApiClient();

/**
 * Captures operator enqueue intent and returns tracking metadata so run monitoring can start immediately.
 */
export function EnqueueRoute() {
  const [symbolInput, setSymbolInput] = useState("");
  const [force, setForce] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const enqueueMutation = useMutation({
    mutationFn: async () => {
      const symbol = symbolInput.trim();
      if (!symbol) {
        throw new Error("Enter a symbol or company alias.");
      }

      return apiClient.enqueueRun({
        symbol,
        force,
      });
    },
  });

  const errorMessage = useMemo(() => {
    if (validationMessage) {
      return validationMessage;
    }

    if (!enqueueMutation.error) {
      return null;
    }

    if (enqueueMutation.error instanceof OpsConsoleApiError) {
      return enqueueMutation.error.message;
    }

    return "Unable to enqueue run.";
  }, [enqueueMutation.error, validationMessage]);

  return (
    <section className="space-y-6 rounded-xl border border-slate-800 bg-slate-900 p-6">
      <header>
        <h2 className="text-base font-semibold">Enqueue Run</h2>
        <p className="mt-2 text-sm text-slate-300">
          Submit a symbol or company alias to start a new research run.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const symbol = symbolInput.trim();

          if (!symbol) {
            setValidationMessage("Enter a symbol or company alias.");
            return;
          }

          setValidationMessage(null);
          enqueueMutation.reset();
          void enqueueMutation.mutateAsync();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-sm text-slate-200">
            Symbol or alias
          </span>
          <input
            value={symbolInput}
            onChange={(event) => {
              setSymbolInput(event.target.value);
              if (validationMessage) {
                setValidationMessage(null);
              }
            }}
            placeholder="AAPL or ROLLS ROYCE"
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-blue-500/60 placeholder:text-slate-500 focus:ring"
          />
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => {
              setForce(event.target.checked);
            }}
            className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-500 focus:ring-blue-500/60"
          />
          Force enqueue (bypass idempotency dedupe)
        </label>

        <button
          type="submit"
          disabled={enqueueMutation.isPending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700"
        >
          {enqueueMutation.isPending ? "Submitting..." : "Enqueue"}
        </button>
      </form>

      {errorMessage ? (
        <ErrorState title="Enqueue failed" message={errorMessage} />
      ) : null}

      {enqueueMutation.data ? (
        <section className="rounded-xl border border-emerald-700/60 bg-emerald-900/20 p-4">
          <h3 className="text-sm font-semibold text-emerald-200">
            Run accepted
          </h3>
          <dl className="mt-3 grid gap-2 text-sm text-emerald-100 sm:grid-cols-2">
            <div>
              <dt className="text-emerald-300">runId</dt>
              <dd className="break-all">{enqueueMutation.data.runId}</dd>
            </div>
            <div>
              <dt className="text-emerald-300">taskId</dt>
              <dd className="break-all">{enqueueMutation.data.taskId}</dd>
            </div>
            <div>
              <dt className="text-emerald-300">requestedSymbol</dt>
              <dd>{enqueueMutation.data.requestedSymbol}</dd>
            </div>
            <div>
              <dt className="text-emerald-300">canonicalSymbol</dt>
              <dd>{enqueueMutation.data.canonicalSymbol}</dd>
            </div>
            <div>
              <dt className="text-emerald-300">idempotencyKey</dt>
              <dd className="break-all">
                {enqueueMutation.data.idempotencyKey}
              </dd>
            </div>
            <div>
              <dt className="text-emerald-300">forceApplied</dt>
              <dd>{enqueueMutation.data.forceApplied ? "true" : "false"}</dd>
            </div>
            <div>
              <dt className="text-emerald-300">enqueuedAt</dt>
              <dd>{formatIsoDate(enqueueMutation.data.enqueuedAt)}</dd>
            </div>
          </dl>
          <div className="mt-4">
            <Link
              to={`/runs?runId=${encodeURIComponent(enqueueMutation.data.runId)}`}
              className="text-sm font-medium text-emerald-200 underline underline-offset-2 hover:text-emerald-100"
            >
              Open run monitor
            </Link>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function formatIsoDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

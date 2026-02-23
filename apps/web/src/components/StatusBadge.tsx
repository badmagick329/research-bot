type RunStatus = "running" | "success" | "degraded" | "failed";

type StatusBadgeProps = {
  status: RunStatus;
};

const STATUS_STYLES: Record<RunStatus, string> = {
  running: "border-blue-400/40 bg-blue-500/15 text-blue-200",
  success: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  degraded: "border-amber-400/40 bg-amber-500/15 text-amber-200",
  failed: "border-rose-400/40 bg-rose-500/15 text-rose-200",
};

/**
 * Shows compact status color semantics so operators can scan run health quickly in dense layouts.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * Reserves run-monitor route surface so polling and diagnostics rendering can be added without shell churn.
 */
export function RunMonitorRoute() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-base font-semibold">Run Monitor</h2>
      <p className="mt-2 text-sm text-slate-300">
        Phase 4 will add run detail polling, stage timeline, and diagnostics
        status blocks.
      </p>
    </section>
  );
}

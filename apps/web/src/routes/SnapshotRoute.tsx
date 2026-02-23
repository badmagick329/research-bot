/**
 * Holds snapshot view route so identity and quality rendering can be layered in during feature phase.
 */
export function SnapshotRoute() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-base font-semibold">Latest Snapshot</h2>
      <p className="mt-2 text-sm text-slate-300">
        Phase 4 will add symbol lookup and rich snapshot diagnostics rendering.
      </p>
    </section>
  );
}

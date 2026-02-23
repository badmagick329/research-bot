/**
 * Keeps the route reserved for enqueue UX so foundation work lands without premature form behavior.
 */
export function EnqueueRoute() {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 className="text-base font-semibold">Enqueue Run</h2>
      <p className="mt-2 text-sm text-slate-300">
        Phase 4 will add symbol input, force toggle, and enqueue submission
        feedback.
      </p>
    </section>
  );
}

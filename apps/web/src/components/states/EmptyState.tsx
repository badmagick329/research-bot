type EmptyStateProps = {
  title: string;
  message: string;
};

/**
 * Establishes a reusable empty-state container so routes can explain absent data in a predictable way.
 */
export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 text-sm text-slate-300">{message}</p>
    </div>
  );
}

type ErrorStateProps = {
  title?: string;
  message: string;
};

/**
 * Standardizes error presentation so API and validation failures are surfaced consistently across routes.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
}: ErrorStateProps) {
  return (
    <div className="rounded-xl border border-rose-700/60 bg-rose-900/20 p-6">
      <h3 className="text-sm font-semibold text-rose-200">{title}</h3>
      <p className="mt-2 text-sm text-rose-100">{message}</p>
    </div>
  );
}

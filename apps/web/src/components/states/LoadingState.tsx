type LoadingStateProps = {
  message?: string;
};

/**
 * Provides one loading primitive so pending views remain consistent as feature routes are implemented.
 */
export function LoadingState({ message = "Loading..." }: LoadingStateProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-300">
      {message}
    </div>
  );
}

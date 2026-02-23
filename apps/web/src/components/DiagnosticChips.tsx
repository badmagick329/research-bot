type DiagnosticChipsProps = {
  items: string[];
};

/**
 * Renders compact diagnostics tokens so warning context is visible without overwhelming route layouts.
 */
export function DiagnosticChips({ items }: DiagnosticChipsProps) {
  if (items.length === 0) {
    return <span className="text-sm text-slate-400">No diagnostics.</span>;
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item}
          className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

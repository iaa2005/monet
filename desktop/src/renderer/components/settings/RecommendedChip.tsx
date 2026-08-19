/**
 * "recommended" — the one chip that says which option to take.
 *
 * Written once because it had already been drawn twice by hand (the sandbox
 * engine picker in the Home header and its card in Settings), and a fourth
 * copy is how two of them end up different greens.
 *
 * Use it sparingly: a list where several rows are recommended recommends
 * nothing. One per list, on the option someone with no opinion should pick.
 */
export function RecommendedChip(): JSX.Element {
  return (
    <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
      recommended
    </span>
  );
}

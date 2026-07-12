/**
 * Reasoning-effort slider — a compact square horizontal control (Faster ↔
 * Smarter). Four discrete steps (Off/Low/Medium/High) fill left-to-right and
 * the value label is tinted grey → blue → light purple as effort rises.
 */
import { cn } from "@/lib/utils";

export type EffortValue = "low" | "medium" | "high" | null;

const STEPS: EffortValue[] = [null, "low", "medium", "high"];
const LABELS = ["Off", "Low", "Medium", "High"];
// Fill + label tint per step: grey → light blue → light purple.
const FILL = [
  "bg-muted-foreground/40",
  "bg-slate-400",
  "bg-sky-400",
  "bg-violet-400",
];
const TEXT = [
  "text-muted-foreground",
  "text-slate-500 dark:text-slate-300",
  "text-sky-500 dark:text-sky-400",
  "text-violet-500 dark:text-violet-400",
];

export function EffortSlider({
  value,
  onChange,
}: {
  value: EffortValue;
  onChange: (v: EffortValue) => void;
}): JSX.Element {
  const idx = Math.max(0, STEPS.indexOf(value));
  return (
    <div
      className="flex items-center gap-1.5"
      title="Reasoning effort — Faster ↔ Smarter"
    >
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Faster
      </span>
      <div className="flex items-center gap-0.5">
        {STEPS.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={LABELS[i]}
            title={LABELS[i]}
            onClick={() => onChange(s)}
            className={cn(
              "h-3.5 w-2.5 rounded-[2px] transition-colors",
              i <= idx ? FILL[idx] : "bg-black/[0.08] dark:bg-white/[0.12]",
            )}
          />
        ))}
      </div>
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Smarter
      </span>
      <span className={cn("min-w-[3.1rem] text-[11px] font-semibold", TEXT[idx])}>
        {LABELS[idx]}
      </span>
    </div>
  );
}

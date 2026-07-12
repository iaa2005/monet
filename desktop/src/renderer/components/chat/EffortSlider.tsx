/**
 * Reasoning-effort slider — a compact square horizontal control (Faster ↔
 * Smarter) shown INSIDE the Effort dropdown. Seven steps (Off … Max) fill
 * left-to-right, tinted grey → blue → light purple as effort rises. The
 * composer pill shows just the current level, coloured via the exported
 * helpers.
 */
import { cn } from "@/lib/utils";

export type EffortValue =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | null;

const STEPS: EffortValue[] = [
  null,
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const LABELS = ["Off", "Minimal", "Low", "Medium", "High", "X-High", "Max"];

// Fill + label tint per step: grey → blue → light purple.
const FILL = [
  "bg-muted-foreground/40",
  "bg-slate-400",
  "bg-sky-500",
  "bg-sky-400",
  "bg-indigo-400",
  "bg-violet-400",
  "bg-fuchsia-400",
];
const TEXT = [
  "text-muted-foreground",
  "text-slate-500 dark:text-slate-300",
  "text-sky-600 dark:text-sky-400",
  "text-sky-500 dark:text-sky-400",
  "text-indigo-500 dark:text-indigo-400",
  "text-violet-500 dark:text-violet-400",
  "text-fuchsia-500 dark:text-fuchsia-400",
];

const stepIndex = (v: EffortValue): number => Math.max(0, STEPS.indexOf(v));

/** "Off" / "High" / … for the current value. */
export function effortLabel(v: EffortValue): string {
  return LABELS[stepIndex(v)];
}
/** Tailwind text-colour class for the current value (grey → blue → purple). */
export function effortTextClass(v: EffortValue): string {
  return TEXT[stepIndex(v)];
}

export function EffortSlider({
  value,
  onChange,
}: {
  value: EffortValue;
  onChange: (v: EffortValue) => void;
}): JSX.Element {
  const idx = stepIndex(value);
  return (
    <div className="px-1 py-0.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Faster</span>
        <span className={cn("normal-case", TEXT[idx])}>{LABELS[idx]}</span>
        <span>Smarter</span>
      </div>
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={LABELS[i]}
            title={LABELS[i]}
            onClick={() => onChange(s)}
            className={cn(
              "h-4 flex-1 rounded-[3px] transition-colors",
              i <= idx ? FILL[idx] : "bg-black/[0.08] dark:bg-white/[0.12]",
              "hover:opacity-80",
            )}
          />
        ))}
      </div>
    </div>
  );
}

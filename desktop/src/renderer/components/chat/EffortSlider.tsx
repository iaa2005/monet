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
  "bg-muted-foreground",
  "bg-slate-400",
  "bg-sky-300",
  "bg-sky-500",
  "bg-indigo-400",
  "bg-violet-400",
  "bg-fuchsia-400",
];
const BGBUTTON = [
  "hover:bg-muted-foreground/10 dark:hover:bg-muted-foreground/20 hover:cursor-pointer",
  "hover:bg-slate-400/20 dark:hover:bg-slate-400/30 hover:cursor-pointer",
  "hover:bg-sky-300/20 dark:hover:bg-sky-300/30 hover:cursor-pointer",
  "hover:bg-sky-500/20 dark:hover:bg-sky-500/30 hover:cursor-pointer",
  "hover:bg-indigo-400/20 dark:hover:bg-indigo-400/30 hover:cursor-pointer",
  "hover:bg-violet-400/20 dark:hover:bg-violet-400/30 hover:cursor-pointer",
  "hover:bg-fuchsia-400/20 dark:hover:bg-fuchsia-400/30 hover:cursor-pointer",
];
const TEXT = [
  "text-muted-foreground",
  "text-slate-500 dark:text-slate-300",
  "text-sky-400 dark:text-sky-300",
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

/** Background colour for the current value  */
export function effortBgClass(v: EffortValue): string {
  return BGBUTTON[stepIndex(v)];
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
    <div className="p-1.5">
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

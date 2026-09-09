/**
 * Reasoning-effort slider — a compact horizontal control (Faster ↔ Smarter)
 * shown INSIDE the Effort dropdown, tinted grey → blue → light purple as
 * effort rises. The composer pill shows just the current level, coloured via
 * the exported helpers.
 *
 * The steps come from the MODEL, not from here. There used to be seven of
 * them, the same seven for everybody, and that was wrong nearly everywhere:
 * llama.cpp takes four (low…xhigh, no "minimal", no "max"), OpenAI takes a
 * different four, Anthropic has no named levels at all. Two of the seven did
 * literally nothing on most models — the client clamped them — while the
 * slider showed them as distinct, harder-thinking settings.
 *
 * So this draws whatever ladder it is handed, of whatever length, in
 * whatever order, under whatever names. @shared/effort.ts owns where a
 * ladder comes from and how a choice moves between two of them.
 */
import { prettyEffort } from "@shared/effort";
import { cn } from "@/lib/utils";

/** A step, or null for "off" — leave it to the provider's own default. */
export type EffortValue = string | null;

/**
 * The palette, sampled rather than indexed.
 *
 * Seven colours for a ladder that may have three steps or eight: position on
 * the ladder picks a colour from the scale, so the weakest step is always
 * grey and the strongest always the far end, whatever the length.
 */
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

/** Every position the control offers: "off", then the model's own steps. */
function stepsOf(ladder: readonly string[]): EffortValue[] {
  return [null, ...ladder];
}

function stepIndex(v: EffortValue, ladder: readonly string[]): number {
  if (!v) return 0;
  const want = v.trim().toLowerCase();
  const i = ladder.findIndex((l) => l.toLowerCase() === want);
  return i < 0 ? 0 : i + 1;
}

/** Where this step falls on the seven-colour scale. */
function tone(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round((index / (count - 1)) * (FILL.length - 1));
}

/** "Off" / "High" / "X-High" / whatever the model calls it. */
export function effortLabel(v: EffortValue): string {
  return v ? prettyEffort(v) : "Off";
}

/** Tailwind text-colour class for the current value (grey → blue → purple). */
export function effortTextClass(
  v: EffortValue,
  ladder: readonly string[],
): string {
  const steps = stepsOf(ladder);
  return TEXT[tone(stepIndex(v, ladder), steps.length)]!;
}

/** Background colour for the current value. */
export function effortBgClass(
  v: EffortValue,
  ladder: readonly string[],
): string {
  const steps = stepsOf(ladder);
  return BGBUTTON[tone(stepIndex(v, ladder), steps.length)]!;
}

export function EffortSlider({
  value,
  ladder,
  onChange,
}: {
  value: EffortValue;
  /** This model's steps, weakest first. */
  ladder: readonly string[];
  onChange: (v: EffortValue) => void;
}): JSX.Element {
  const steps = stepsOf(ladder);
  const idx = stepIndex(value, ladder);
  const fill = FILL[tone(idx, steps.length)]!;
  return (
    <div className="p-1.5">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Faster</span>
        <span className={cn("normal-case", TEXT[tone(idx, steps.length)])}>
          {effortLabel(value)}
        </span>
        <span>Smarter</span>
      </div>
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <button
            key={s ?? "off"}
            type="button"
            aria-label={effortLabel(s)}
            title={effortLabel(s)}
            onClick={() => onChange(s)}
            className={cn(
              "h-4 flex-1 rounded-[3px] transition-colors",
              i <= idx ? fill : "bg-black/[0.08] dark:bg-white/[0.12]",
              "hover:opacity-80",
            )}
          />
        ))}
      </div>
      {/* The names, spelled out. A bar chart is fine for "more or less", but
          the steps are not universal — someone switching from a six-step
          model to a four-step one needs to see WHAT the four are, not just
          that there are four of them. */}
      <div className="mt-1 flex items-center gap-1">
        {steps.map((s, i) => (
          <button
            key={`l-${s ?? "off"}`}
            type="button"
            onClick={() => onChange(s)}
            className={cn(
              "min-w-0 flex-1 truncate rounded-[3px] px-0.5 py-0.5 text-center text-[9px] leading-tight transition-colors",
              i === idx
                ? cn("font-semibold", TEXT[tone(idx, steps.length)])
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {effortLabel(s)}
          </button>
        ))}
      </div>
    </div>
  );
}

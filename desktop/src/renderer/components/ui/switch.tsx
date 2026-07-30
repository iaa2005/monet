/**
 * Switch — the app-wide on/off toggle (pill with a sliding knob), the same
 * look as Settings → Memory. Use it for every boolean setting instead of a
 * bare checkbox.
 */
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors",
        checked ? "bg-[#6896dc]" : "bg-black/[0.15] dark:bg-white/[0.2]",
        disabled && "opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

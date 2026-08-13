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
        "relative h-[22px] w-10 shrink-0 rounded-full border transition-colors",
        // Off is not a grey slab: it is the same wash-inside-an-edge the rest
        // of the app uses, so the control reads as part of the design even
        // when it is doing nothing. On fills the edge in.
        checked
          ? "border-brand bg-brand"
          : "border-brand/60 bg-accent",
        disabled && "opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[1px] size-[18px] rounded-full bg-white shadow transition-all",
          checked ? "left-[19px]" : "left-[1px]",
        )}
      />
    </button>
  );
}

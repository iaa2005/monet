/**
 * The app's own select — a native `<select>` cannot be styled.
 *
 * Chromium paints the popup list with the OS widget: our fonts, radii, colours
 * and the dark theme stop at the button's edge, which is why every native
 * select in a dark app flashes a white list. Radix renders the list as real
 * DOM, so it inherits everything the rest of the UI has.
 *
 * The API stays close to what it replaces (value / onChange / options), so a
 * `<select>` becomes a `<Select>` without restructuring the caller.
 */

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Rendered before the label in both the trigger and the list. */
  icon?: React.ReactNode;
  /** Right-aligned, muted — a kind, a count, a hint. */
  hint?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  contentClassName,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
}): JSX.Element {
  const selected = options.find((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none transition-colors",
          "hover:bg-black/[0.03] focus:border-foreground/30 disabled:opacity-50 dark:hover:bg-white/[0.04]",
          "data-[placeholder]:text-muted-foreground",
          className,
        )}
      >
        {selected?.icon}
        <SelectPrimitive.Value placeholder={placeholder}>
          {selected?.label}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95",
            contentClassName,
          )}
        >
          <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={cn(
                  "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 pr-7 text-xs outline-none",
                  "data-[highlighted]:bg-black/[0.05] data-[disabled]:opacity-50 dark:data-[highlighted]:bg-white/[0.06]",
                )}
              >
                {o.icon}
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {o.hint}
                  </span>
                )}
                <SelectPrimitive.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A time field as two selects — `<input type="time">` has the same problem as
 * a native select, plus a browser-drawn clock popup and locale-dependent
 * AM/PM parsing. Two lists of numbers are unambiguous and ours.
 *
 * Value and onChange speak "HH:MM" (24h), exactly like the input it replaces.
 */
export function TimeSelect({
  value,
  onChange,
  minuteStep = 5,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  minuteStep?: number;
  className?: string;
}): JSX.Element {
  const [h, m] = value.split(":");
  const hour = Number.isFinite(Number(h)) ? pad(Number(h)) : "09";
  const minute = Number.isFinite(Number(m)) ? pad(Number(m)) : "00";

  const hours = React.useMemo(
    () => Array.from({ length: 24 }, (_, i) => ({ value: pad(i), label: pad(i) })),
    [],
  );
  // The current minute always appears, even off-step: a routine saved at :07
  // must not silently round when its editor opens.
  const minutes = React.useMemo(() => {
    const set = new Set<string>();
    for (let i = 0; i < 60; i += minuteStep) set.add(pad(i));
    set.add(minute);
    return [...set]
      .sort((a, b) => Number(a) - Number(b))
      .map((v) => ({ value: v, label: v }));
  }, [minuteStep, minute]);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Select
        ariaLabel="Hour"
        value={hour}
        onChange={(v) => onChange(`${v}:${minute}`)}
        options={hours}
        className="tabular-nums"
      />
      <span className="text-muted-foreground">:</span>
      <Select
        ariaLabel="Minute"
        value={minute}
        onChange={(v) => onChange(`${hour}:${v}`)}
        options={minutes}
        className="tabular-nums"
      />
    </span>
  );
}

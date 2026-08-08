/**
 * A choice you can see: the card the voice list uses, for everything that is a
 * pick-one-of-several.
 *
 * The voice picker ended up the nicest surface in Settings — an icon tile, a
 * name, one line of what it is, a tick when chosen and a download glyph when it
 * is not here yet, the whole row ringed in brand when selected. Dictation
 * engines, browser engines and providers were all the same kind of choice drawn
 * three other ways: bare rows with a tick, radio-ish buttons, plain list items.
 *
 * One component, so they cannot drift again — and so "make it look like Voice"
 * is a one-line change rather than a re-draw.
 */

import type { ComponentType, ReactNode } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function PickCard({
  icon: Icon,
  /** Anything square — the voice map, a logo — instead of an icon. */
  art,
  title,
  badge,
  description,
  selected = false,
  /** Shows the download glyph: here to be chosen, not here yet. */
  needsDownload = false,
  busy = false,
  disabled = false,
  /** 0…100 while something downloads. Takes the place of the state glyph and
   * draws a bar under the row — a 230 MB model needs to say how far it is. */
  progress,
  onClick,
  /** Trailing controls (cancel, delete, download). Never the tick. */
  trailing,
  /** A compartment under the row, flush to the card's edges. */
  footer,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  art?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  needsDownload?: boolean;
  busy?: boolean;
  disabled?: boolean;
  progress?: number | null;
  onClick?: () => void;
  trailing?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const downloading = typeof progress === "number";
  return (
    <div
      className={cn(
        "rounded-xl border p-2 transition-colors",
        selected
          ? "border-brand/40 bg-brand/[0.06]"
          : "border-border hover:border-foreground/20",
        disabled && "opacity-50",
      )}
    >
      <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || !onClick}
        className="flex min-w-0 flex-1 items-start gap-3 text-left"
      >
        {art ??
          (Icon && (
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
                // The icon carries the state, as in the capability cards on
                // the Advanced tab: a chosen row is findable by eye.
                selected ? "bg-brand/12 text-brand" : "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
            </span>
          ))}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium">{title}</span>
            {badge}
          </span>
          {description && (
            <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </span>
          )}
          {children}
        </span>
      </button>
        {busy ? (
          <Loader2 className="mt-1.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : downloading ? (
          <span className="mt-1 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {progress}%
          </span>
        ) : selected ? (
          <Check className="mt-1.5 size-4 shrink-0 text-brand" />
        ) : needsDownload ? (
          <Download className="mt-1.5 size-3.5 shrink-0 text-muted-foreground/60" />
        ) : null}
        {trailing}
      </div>
      {footer && (
        <div className="-mx-2 -mb-2 mt-2 border-t border-border/70 px-2 py-1.5">
          {footer}
        </div>
      )}
      {downloading && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
          <div
            className="h-full rounded-full bg-brand transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

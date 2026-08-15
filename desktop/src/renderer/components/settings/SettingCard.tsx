/**
 * One setting, in a box.
 *
 * Settings screens here used to be bare rows separated by margins, and a
 * margin is not a boundary: a two-line description under one heading sits
 * as close to the NEXT heading as to its own, so the eye pairs them wrong
 * and the page reads as one run-on list. Reported on the Memory tab, where
 * four sections with paragraphs and buttons ran together.
 *
 * A card fixes it structurally rather than by adding more space: the
 * boundary is drawn, the icon anchors the left edge, the control sits on
 * the right, and anything extra (a picker, a status line, a list) goes
 * UNDER the description inside the same box, where it is visibly part of
 * that setting and not the start of the next one.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "@/components/icons/hg";

export function SettingCard({
  icon: Icon,
  title,
  description,
  /** The switch / button / picker on the right of the title row. */
  control,
  /** Badge next to the title — used for what a capability costs. */
  badge,
  /** Whether the icon reads as active. */
  on = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  badge?: ReactNode;
  on?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border p-3 transition-colors hover:border-foreground/20">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={
            // The icon carries the state, so an enabled setting is findable by
            // eye in a long list.
            on
              ? "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand"
              : "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          }
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            {badge}
          </div>
          {description && (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {control && <div className="mt-0.5 shrink-0">{control}</div>}
      </div>
      {/* FULL WIDTH, below the row — not tucked into the text column beside the
          icon. A lessons preview or a picker inset by an icon's width reads as
          a mistake, and the indent buys nothing. */}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

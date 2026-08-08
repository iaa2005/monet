/**
 * The heading every settings section wears.
 *
 * There were 27 of them in three spellings — `text-base font-semibold` on 25,
 * `text-sm font-semibold text-foreground` on two — all in Inter, while the
 * rest of the app's headings are Bounded. Three sizes and two faces on one
 * screen, which is what "make the titles the same" means: not a sweep, a
 * component, so the next section cannot invent a fourth.
 *
 * The size and weight match the wordmark in the header (`font-display
 * text-[15px] font-semibold tracking-tight`) — the app already had exactly one
 * display convention, so this is it rather than a new number.
 *
 * Sub-headings inside a section are NOT this: the code-theme picker's
 * Light/Dark and the uppercase group labels are deliberately smaller and stay
 * in the UI face.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionTitle({
  children,
  className,
}: {
  children: ReactNode;
  /** Layout only — flex for an icon, a margin, `truncate`. Never type. */
  className?: string;
}): JSX.Element {
  return (
    <h3
      className={cn(
        "font-display text-[15px] font-semibold tracking-tight text-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

/**
 * The line under a title, which had as many spellings as the title did:
 * `text-xs`, `text-[13px]`, `text-sm`, some with `mb-3` and some without, some
 * `text-muted-foreground` and one `text-muted-foreground/80`.
 *
 * Kept beside SectionTitle deliberately: a heading and its explanation are one
 * decision, so both are edited in one file.
 */
export function SectionDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p
      className={cn(
        "mt-1 text-[13px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Both at once — what almost every settings section actually opens with.
 * `description` takes nodes, not just text, so a section that needs a link or
 * a bit of code in its explanation does not have to fall back to raw markup.
 */
export function SectionHeader({
  title,
  description,
  /** Sits on the title's row, right-aligned: a switch, a button, a count. */
  control,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("mb-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <SectionTitle>{title}</SectionTitle>
        {control}
      </div>
      {description && <SectionDescription>{description}</SectionDescription>}
    </div>
  );
}

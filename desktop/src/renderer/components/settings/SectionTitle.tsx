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

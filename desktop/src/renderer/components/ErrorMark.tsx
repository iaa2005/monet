/**
 * The mark a list wears when something stopped on an error.
 *
 * A chat that died mid-turn looked exactly like a chat that finished: the same
 * grey dot in the sidebar, nothing to notice while scanning the list. It is
 * amber rather than red because nothing is broken — the run stopped, and the
 * chat is still there to continue; red is for what cannot be recovered.
 *
 * One component so the sessions list and the routines list cannot drift into
 * two different warnings for the same thing.
 */

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export function ErrorMark({
  title = "Stopped with an error",
  className,
}: {
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      aria-label={title}
      className="flex shrink-0 items-center"
    >
      <AlertTriangle className={cn("size-3.5 text-amber-500", className)} />
    </span>
  );
}

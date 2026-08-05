/**
 * Kbd — a keycap, the shadcn/ui shape mapped onto the app's tokens.
 *
 * Used directly in JSX (hotkey lists) and as the renderer for literal
 * <kbd> tags in documentation Markdown (MarkdownViewer maps the tag here
 * when docs HTML is enabled). One component, so every keycap in the app
 * is the same keycap.
 */

import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Kbd({
  className,
  ...props
}: HTMLAttributes<HTMLElement>): JSX.Element {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-sm border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A row of keycaps with the separators drawn as quiet text, not caps:
 * `<KbdGroup keys={["Ctrl", "Shift", "D"]} />` → Ctrl + Shift + D. */
export function KbdGroup({
  keys,
  className,
}: {
  keys: string[];
  className?: string;
}): JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[11px] text-muted-foreground/60">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}

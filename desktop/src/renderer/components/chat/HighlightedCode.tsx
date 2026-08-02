/**
 * A block of code, highlighted — the chat's own renderer.
 *
 * Split from `highlight.tsx` (which now exports only functions) because React
 * Fast Refresh cannot hot-update a module that exports both a component and
 * plain helpers: it reloads the page instead, and a reload takes the
 * conversation on screen with it.
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { linesFor } from "./highlight";

export function HighlightedCode({
  code,
  language = "text",
  showLineNumbers = false,
  className,
}: {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  className?: string;
}): JSX.Element {
  const lines = useMemo(() => linesFor(code, language), [code, language]);
  // Numbers are text, not CSS counters: a counter would restart wherever a
  // containment boundary begins.
  const digits = String(lines.length).length;
  return (
    <pre
      className={cn(
        "diff-hl m-0 whitespace-pre-wrap break-words",
        showLineNumbers && "show-ln",
        className,
      )}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
        lineHeight: "1.6",
        background: "transparent",
        padding: "0.75rem",
        ["--ln-digits" as string]: digits,
      }}
    >
      <code>
        {lines.map((node, i) => (
          <span key={i} className="line">
            {showLineNumbers ? <span className="ln">{i + 1}</span> : null}
            <span className="cl">{node}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

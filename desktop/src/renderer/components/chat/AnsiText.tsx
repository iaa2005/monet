/**
 * Command output, with its own colours.
 *
 * Everything a tool runs paints itself — Vite, npm, cargo, jest — and printed
 * literally those escapes are worse than noise. See lib/ansi.ts for the parse;
 * this only draws it.
 */

import { Fragment, useMemo } from "react";
import { parseAnsi } from "@/lib/ansi";

export function AnsiText({ text }: { text: string }): JSX.Element {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((s, i) => (
        <Fragment key={i}>
          {s.style.color ||
          s.style.background ||
          s.style.bold ||
          s.style.dim ||
          s.style.italic ||
          s.style.underline ? (
            <span
              style={{
                color: s.style.color,
                background: s.style.background,
                fontWeight: s.style.bold ? 600 : undefined,
                // Dim is the terminal's way of saying "secondary", which is
                // what an opacity does here without inventing a second palette.
                opacity: s.style.dim ? 0.65 : undefined,
                fontStyle: s.style.italic ? "italic" : undefined,
                textDecoration: s.style.underline ? "underline" : undefined,
              }}
            >
              {s.text}
            </span>
          ) : (
            s.text
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Drawing ⟨references⟩ in the composer as chips.
 *
 * A textarea cannot style part of its own value, so this is a layer BEHIND it,
 * holding the same string with the same metrics, where the token characters get
 * a rounded tint. The textarea keeps its real, visible text on top.
 *
 * The alternative — transparent text with everything drawn here — buys coloured
 * glyphs and an icon, and costs the native selection, the caret and the IME
 * composition popup all being drawn against text that is not there. A chip that
 * is one pixel out of alignment is worse than a chip without an icon, so the
 * width comes from the characters themselves and nothing is padded.
 */

import { Fragment, forwardRef } from "react";
import { REF_TOKEN } from "@/lib/selection-marks";

/**
 * Must match the textarea's own typography and box exactly, or the tint slides
 * off the word it belongs to. Kept next to it in MessageInput for that reason.
 */
export const COMPOSER_TEXT =
  "pt-1 pl-1 text-sm leading-relaxed whitespace-pre-wrap break-words";

export const TokenHighlight = forwardRef<HTMLDivElement, { text: string }>(
  function TokenHighlight({ text }, ref) {
    const parts: React.ReactNode[] = [];
    let last = 0;
    REF_TOKEN.lastIndex = 0;
    for (const m of text.matchAll(REF_TOKEN)) {
      const at = m.index ?? 0;
      if (at > last) parts.push(text.slice(last, at));
      parts.push(
        <span
          key={at}
          // No padding and no border: either would change the width and push
          // the real text out from under its own chip.
          className="rounded-[4px] bg-link/20 shadow-[inset_0_0_0_1px_hsl(var(--link)/0.35)]"
        >
          {m[0]}
        </span>,
      );
      last = at + m[0].length;
    }
    parts.push(text.slice(last));
    // A trailing newline is not rendered by a div the way a textarea renders
    // it, so the last line would sit one row too high while typing.
    parts.push("\n");

    return (
      <div
        ref={ref}
        aria-hidden
        className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${COMPOSER_TEXT}`}
      >
        {parts.map((p, i) => (
          <Fragment key={i}>{p}</Fragment>
        ))}
      </div>
    );
  },
);

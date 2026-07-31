/**
 * A message that referred to something on a page, drawn for a person.
 *
 * The text carries two things the model needs and the reader does not: a
 * ⟨reference⟩ inline, and a block underneath describing the element down to its
 * computed styles. The block is hidden here — printed verbatim it turned a
 * two-word instruction into something that looked like a stack trace — and the
 * reference becomes a pill you can hover to see where it pointed.
 *
 * Nothing is removed from the message itself. This only decides what is drawn.
 */

import { Fragment } from "react";
import { MousePointerClick } from "lucide-react";
import { chipColors } from "@shared/selection-tones";
import {
  REF_TOKEN,
  splitSelections,
  type SelectionRef,
} from "@/lib/selection-marks";
import type { ChatAttachmentMeta } from "@/types/chat";
import { useIsDark } from "./highlight";

/** The bits of a block worth showing on hover — not all forty lines of it. */
function tooltipFor(ref: SelectionRef): string {
  const keep = ["selector:", "xpath:", "source:", "text:", "likely source files:"];
  const lines = ref.raw
    .split("\n")
    .filter((l) => keep.some((k) => l.startsWith(k)));
  return [ref.url, ...lines].filter(Boolean).join("\n");
}

export function SelectionText({
  content,
  crops = [],
}: {
  content: string;
  /** Crops the browser tool made, in the order the references appear. */
  crops?: ChatAttachmentMeta[];
}): JSX.Element {
  const dark = useIsDark();
  const { text, refs } = splitSelections(content);
  if (refs.length === 0 && !REF_TOKEN.test(text)) return <>{content}</>;

  // Refs are consumed in the order their tokens appear, so a pill shows the
  // element it actually stands for when a message carries several.
  const queue = refs.map((r, i) => ({ ref: r, crop: crops[i] }));
  const byLabel = (
    label: string,
  ): { ref: SelectionRef; crop?: ChatAttachmentMeta } | undefined => {
    const at = queue.findIndex((r) => r.ref.label === label);
    return at < 0 ? undefined : queue.splice(at, 1)[0];
  };

  /** Same hash the composer uses, so a chip keeps its colour after a reload. */
  const toneOf = (label: string): number => {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0;
    return Math.abs(h);
  };

  const parts: React.ReactNode[] = [];
  let last = 0;
  // matchAll needs a fresh index — REF_TOKEN is a module-level global regex.
  REF_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const label = m[1] ?? "";
    const hit = byLabel(label);
    const c = chipColors(toneOf(label), dark);
    const thumb = hit?.crop?.dataUrl;
    parts.push(
      <span
        key={`${at}-${label}`}
        title={hit ? tooltipFor(hit.ref) : label}
        style={{
          color: c.fg,
          background: c.bg,
          boxShadow: `inset 0 0 0 1px ${c.ring}`,
        }}
        className="mx-0.5 inline-flex items-center gap-1 rounded-[5px] py-px pl-1 pr-1.5 align-baseline font-medium"
      >
        {/* The crop lives ON the chip: the browser tool made it, so it is part
            of the reference rather than a file anyone chose to attach. */}
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="size-4 shrink-0 rounded-[3px] object-cover"
          />
        ) : (
          <MousePointerClick className="size-3 shrink-0 opacity-80" />
        )}
        {label}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

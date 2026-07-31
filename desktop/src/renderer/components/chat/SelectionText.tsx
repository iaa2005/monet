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
import {
  REF_TOKEN,
  splitSelections,
  type SelectionRef,
} from "@/lib/selection-marks";

/** The bits of a block worth showing on hover — not all forty lines of it. */
function tooltipFor(ref: SelectionRef): string {
  const keep = ["selector:", "xpath:", "source:", "text:", "likely source files:"];
  const lines = ref.raw
    .split("\n")
    .filter((l) => keep.some((k) => l.startsWith(k)));
  return [ref.url, ...lines].filter(Boolean).join("\n");
}

export function SelectionText({ content }: { content: string }): JSX.Element {
  const { text, refs } = splitSelections(content);
  if (refs.length === 0 && !REF_TOKEN.test(text)) return <>{content}</>;

  // Refs are consumed in the order their tokens appear, so a pill shows the
  // element it actually stands for when a message carries several.
  const queue = [...refs];
  const byLabel = (label: string): SelectionRef | undefined => {
    const at = queue.findIndex((r) => r.label === label);
    return at < 0 ? undefined : queue.splice(at, 1)[0];
  };

  const parts: React.ReactNode[] = [];
  let last = 0;
  // matchAll needs a fresh index — REF_TOKEN is a module-level global regex.
  REF_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const label = m[1] ?? "";
    const ref = byLabel(label);
    parts.push(
      <span
        key={`${at}-${label}`}
        title={ref ? tooltipFor(ref) : label}
        className="mx-0.5 inline-flex items-center gap-1 rounded-[5px] bg-link/12 px-1.5 py-px align-baseline font-mono text-[0.88em] text-link"
      >
        <MousePointerClick className="size-3 shrink-0 opacity-70" />
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

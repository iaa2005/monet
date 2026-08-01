/**
 * Keeping the element context out of the user's face.
 *
 * The model needs the whole description — selector, xpath, computed styles,
 * props, candidate files. The person who clicked a button needs none of it;
 * they wrote "make this centred" and want to read that back. Shipping the raw
 * block into the bubble made a two-word instruction look like a stack trace.
 *
 * So the message carries both, and the two are separated here: a short
 * reference stays inline in the sentence, and the block that explains it is
 * hidden from the transcript. Nothing is stripped from what the model sees —
 * only from what is drawn.
 *
 * Dependency-free: this decides what the user reads, and the round trip
 * (split, edit, re-join) has to be lossless or editing a message quietly
 * throws its context away.
 */

/** What a reference points at. "browser" is the original element pick; the
 * rest arrived with @-mentions and the viewer's code selection. */
export type RefKind = "browser" | "code" | "file" | "chat";

/** One context block (`<selected-from-browser>`, `<referenced-code>`, …), as
 * it sits in a message. */
export interface SelectionRef {
  /** Short name for the pill: a component name, file:lines, chat title. */
  label: string;
  url: string;
  kind: RefKind;
  /** Palette slot the pill is drawn with, when the block records one.
   * Absent on messages written before the tag carried it. */
  tone?: number;
  /** The whole block, verbatim — what goes back to the model. */
  raw: string;
}

// Every context-block tag. The opening tag may carry attributes (tone="3",
// label="…"); the oldest messages have none.
const BLOCK =
  /<(selected-from-browser|referenced-code|referenced-file|referenced-chat)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

const KIND_OF_TAG: Record<string, RefKind> = {
  "selected-from-browser": "browser",
  "referenced-code": "code",
  "referenced-file": "file",
  "referenced-chat": "chat",
};

export function kindOf(block: string): RefKind {
  const m = /^<([a-z-]+)/.exec(block);
  return KIND_OF_TAG[m?.[1] ?? ""] ?? "browser";
}

/** The palette slot this reference was drawn with, when the block says. */
export function toneOf(block: string): number | undefined {
  const m = /^<[a-z-]+\s[^>]*tone="(\d+)"/.exec(block);
  return m ? Number(m[1]) : undefined;
}

/** The inline pill, e.g. ⟨SaveButton⟩. Angle quotes so it reads as prose. */
export const REF_OPEN = "⟨";
export const REF_CLOSE = "⟩";
export const REF_TOKEN = new RegExp(
  `${REF_OPEN}([^${REF_OPEN}${REF_CLOSE}\\n]{1,80})${REF_CLOSE}`,
  "g",
);

export function refToken(label: string): string {
  return `${REF_OPEN}${label}${REF_CLOSE}`;
}

/** A readable name for a block. New tags carry it as label="…"; browser
 * blocks fall back to the component / element line they always had. */
export function labelOf(block: string): string {
  const attr = /^<[a-z-]+\s[^>]*label="([^"]{1,80})"/.exec(block)?.[1];
  if (attr) return attr;
  const component = /^component:\s*<([^>]+)>/m.exec(block)?.[1];
  if (component) return component;
  const element = /^element \d+:\s*(.+)$/m.exec(block)?.[1]?.trim();
  if (element) return element.slice(0, 60);
  return "selection";
}

function urlOf(block: string): string {
  return /^page:.*?—\s*(\S+)\s*$/m.exec(block)?.[1] ?? "";
}

/**
 * Split a message into what to show and what to hide.
 *
 * `text` is the user's own words (with inline references left in place);
 * `refs` are the blocks, in the order they appeared.
 */
export function splitSelections(content: string): {
  text: string;
  refs: SelectionRef[];
} {
  const refs: SelectionRef[] = [];
  const text = content
    .replace(BLOCK, (raw) => {
      refs.push({
        label: labelOf(raw),
        url: urlOf(raw),
        kind: kindOf(raw),
        tone: toneOf(raw),
        raw,
      });
      return "";
    })
    // The blocks were appended after a blank line; removing them leaves it.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, refs };
}

/** Put the blocks back — the inverse of splitSelections, for editing. */
export function joinSelections(text: string, refs: SelectionRef[]): string {
  if (refs.length === 0) return text;
  return [text.trim(), ...refs.map((r) => r.raw)].filter(Boolean).join("\n\n");
}

/** Does this message carry any element context at all? */
export function hasSelections(content: string): boolean {
  BLOCK.lastIndex = 0;
  return BLOCK.test(content);
}

/**
 * The items still referenced by the text.
 *
 * The token IS the reference: delete it while writing and its context does not
 * get sent. That is what a plain-text token buys — no separate "remove
 * attachment" control to keep in sync with what the sentence actually says.
 *
 * Matched by count, because two selections can share a label and only one of
 * them may have survived editing.
 */
export function usedRefs<T>(
  text: string,
  items: readonly T[],
  label: (item: T) => string,
): T[] {
  const counts = new Map<string, number>();
  REF_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const l = m[1] ?? "";
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const out: T[] = [];
  for (const item of items) {
    const l = label(item);
    const left = counts.get(l) ?? 0;
    if (left > 0) {
      counts.set(l, left - 1);
      out.push(item);
    }
  }
  return out;
}

/** One piece of a message: literal text, or a reference to an element. */
export type Piece =
  | { type: "text"; value: string }
  | { type: "chip"; label: string };

/**
 * Split text into pieces, for anything that has to DRAW it.
 *
 * The composer builds DOM from this and reads DOM back into text; the bubble
 * builds React nodes from it. One splitter for both, because "what counts as a
 * reference" drifting between the editor and the transcript is the sort of
 * thing nobody notices until a chip survives a send and dies on reload.
 */
export function tokenize(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  REF_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    out.push({ type: "chip", label: m[1] ?? "" });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

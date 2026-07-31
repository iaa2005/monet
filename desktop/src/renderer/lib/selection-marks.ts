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

/** One `<selected-from-browser>` block, as it sits in a message. */
export interface SelectionRef {
  /** Short name for the pill: a component name, else tag.class. */
  label: string;
  url: string;
  /** The whole block, verbatim — what goes back to the model. */
  raw: string;
}

const BLOCK = /<selected-from-browser>[\s\S]*?<\/selected-from-browser>/g;

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

/** A readable name for a block: the component if it has one, else the tag. */
export function labelOf(block: string): string {
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
      refs.push({ label: labelOf(raw), url: urlOf(raw), raw });
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

/**
 * Where a token sits, if the caret is just past the end of one.
 *
 * So Backspace removes a reference in one press instead of eating it a
 * character at a time — the one thing a real pill would give for free.
 */
export function tokenBefore(
  text: string,
  caret: number,
): { start: number; end: number } | null {
  if (caret <= 0 || text[caret - 1] !== REF_CLOSE) return null;
  const start = text.lastIndexOf(REF_OPEN, caret - 1);
  if (start < 0) return null;
  // A newline between the brackets means these are not a pair.
  if (text.slice(start, caret).includes("\n")) return null;
  return { start, end: caret };
}

/** Insert a reference at the caret, spacing it like a word. */
export function insertRefToken(
  text: string,
  label: string,
  caret: number,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const token = refToken(label);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  const next = `${before}${lead}${token}${tail}${after}`;
  return { text: next, caret: before.length + lead.length + token.length };
}

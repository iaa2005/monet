/**
 * How tall the message box is, when the user has said.
 *
 * By default the composer grows with what you type and stops at a sensible
 * ceiling. Drag its top edge and it stops guessing: the height you left it
 * at is the height it keeps, in this and every later window, until you
 * double-click the edge to hand it back.
 *
 * The bounds live here rather than in the component because main writes
 * this value to disk and has to agree about what is valid — a hand-edited
 * `ui-prefs.json` with `"composerHeight": 40000` should cost nothing.
 */

/** One line — the same floor the box has when it is growing on its own
 * (`min-h-7`), so dragging all the way down lands exactly on the height a
 * fresh composer has rather than stopping short of it. */
export const COMPOSER_MIN_HEIGHT = 28;

/** Above this the composer eats the conversation it is part of. */
export const COMPOSER_MAX_HEIGHT = 740;

/**
 * Where the box stops growing on its own: about ten lines.
 *
 * 10 × 22.75px, the composer's own leading (`text-sm leading-relaxed` =
 * 14px × 1.625). Past that a prompt is a paragraph and scrolling is the
 * right answer — but it used to stop at eight and a half, which is short
 * enough that a normal multi-line prompt made you reach for the handle.
 */
export const COMPOSER_AUTO_MAX_HEIGHT = 228;

/** Where a drag starts from if the box cannot be measured. */
export const COMPOSER_DEFAULT_HEIGHT = 200;

/** A stored height, or null for "grow with the text" — which is what a
 * missing value, a zero and any nonsense all mean. */
export function sanitiseComposerHeight(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampComposerHeight(n);
}

export function clampComposerHeight(px: number): number {
  return Math.round(
    Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, px)),
  );
}

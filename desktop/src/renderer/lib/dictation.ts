/**
 * Joining dictated fragments onto whatever is already in the composer.
 *
 * Pseudo-streaming dictation delivers a phrase at a time (MicButton cuts at
 * speech pauses), and between two fragments the user may have typed. So the
 * seam is not "append with a space": it has to survive a previous fragment
 * that ended mid-sentence, a fragment that starts with a comma, the user's
 * own trailing newline, and GigaAM's habit of punctuating each fragment as
 * if it were a whole utterance — every fragment capitalised, none of them
 * ending in a full stop.
 *
 * The rules, in the order they are decided:
 *
 *   1. Nothing before it → the fragment as it is.
 *   2. Previous text ends in whitespace / a newline → the user's own layout
 *      is deliberate; append with nothing added.
 *   3. The fragment opens with punctuation (`, . ! ? ; : … )`) → glue it on,
 *      no space, because that is what dictating "запятая" produces.
 *   4. Previous text ends with an opening bracket, a quote or a hyphen →
 *      no space either; those characters bind rightwards.
 *   5. Previous text already ends in punctuation → one space.
 *   6. Otherwise the seam is a real pause between two word characters:
 *      a fragment that starts with a capital (or a digit) is a new sentence
 *      and earns ". "; a lower-case one is a continuation and earns " ".
 *
 * Pure and dependency-free: the seam is exactly the kind of thing a probe
 * can pin down, and exactly the kind of thing that rots silently otherwise.
 */

/** Characters that bind to the text on their left — no space before them. */
const LEADING_PUNCT = /^[,.!?;:…)\]}»”"']/u;
/** Characters that bind to the text on their right — no space after them. */
const TRAILING_OPEN = /[([{«„“\-–—/]$/u;
/** Anything that already terminates or separates a clause. */
const TRAILING_PUNCT = /[,.!?;:…)\]}»”"']$/u;

export function joinDictation(prev: string, next: string): string {
  const add = next.trim();
  if (!add) return prev;
  if (!prev) return add;
  // The user's own trailing space or newline is a decision, not an accident.
  if (/\s$/u.test(prev)) return prev + add;
  if (LEADING_PUNCT.test(add)) return prev + add;
  if (TRAILING_OPEN.test(prev)) return prev + add;
  if (TRAILING_PUNCT.test(prev)) return `${prev} ${add}`;
  // Two word characters facing each other across a pause. A capitalised
  // fragment is a new sentence; a lower-case one continues the old one.
  const startsSentence = /^[\p{Lu}\p{N}]/u.test(add);
  return startsSentence ? `${prev}. ${add}` : `${prev} ${add}`;
}

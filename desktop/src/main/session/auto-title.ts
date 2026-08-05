/**
 * Naming a fresh chat.
 *
 * Two small decisions, both of which were quietly wrong and cost every chat
 * its name:
 *
 * 1. Is this chat still unnamed? The renderer saves mid-stream and stamps a
 *    provisional title on the row — the first 60 characters of the user's
 *    message. Anything asking "does it have a title?" after the turn finds
 *    that stamp and concludes yes, so the answer has to be taken BEFORE the
 *    turn runs. The placeholder is the only title that means "not named".
 *
 * 2. What did the model actually reply? A reasoning model that runs out of
 *    budget mid-thought returns its thinking instead of an answer, so the
 *    name — when there is one — is at the END of what came back, not the
 *    start.
 */

/** What a chat is called before anything names it. */
export const TITLE_PLACEHOLDER = "New Session";

/** True when nothing has deliberately named this chat yet. */
export function isUntitled(title: string | undefined | null): boolean {
  return !title || !title.trim() || title === TITLE_PLACEHOLDER;
}

/** The name out of a completion, or "" when there is nothing usable in it. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const last = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!last) return "";
  return last.replace(/^["'«]+|["'»]+$/g, "").slice(0, 60);
}

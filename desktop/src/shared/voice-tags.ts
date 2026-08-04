/**
 * The spoken-expression tags, shared between processes.
 *
 * One home for the list: main's synthesiser keeps the known tags and drops
 * invented ones; the renderer strips them all from the visible transcript.
 * Two copies of this regex would drift, and a drifted copy reads
 * "less-than laugh" aloud or prints it into the chat.
 */

/**
 * The expression tags Supertonic actually understands, per its README. The
 * chat model is told to use exactly these; anything else a model invents is
 * stripped before synthesis rather than read aloud as angle brackets.
 */
export const TTS_TAGS = ["<laugh>", "<sigh>", "<breath>"] as const;

/**
 * Split off expression tags for display: the UI hides them, the voice keeps
 * them. Unknown look-alike tags (<whisper>…) are dropped from BOTH — reading
 * "less-than whisper" aloud is worse than losing the nuance.
 */
export function stripTtsTags(text: string): string {
  return text
    .replace(/<\/?(?:laugh|sigh|breath|pause|whisper|slow|fast|loud|quiet|chuckle|gasp|yawn|cough)>/gi, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** What the synthesiser should see: known tags kept, unknown ones removed. */
export function textForSpeech(text: string): string {
  const known = new Set(TTS_TAGS.map((t) => t.toLowerCase()));
  return text
    .replace(/<\/?[a-z_]{2,12}>/gi, (m) => {
      const bare = m.replace("/", "").toLowerCase();
      return known.has(bare) ? bare : "";
    })
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Markdown, flattened for a mouth instead of a screen.
 *
 * The voice directive asks for prose, but a model deep in a task still emits
 * **bold**, `code`, headings and bullets — and a synthesiser reads the
 * asterisks. Links keep their text, code keeps its content, list markers and
 * emphasis vanish.
 */
export function markdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ 	]{2,}/g, " ");
}

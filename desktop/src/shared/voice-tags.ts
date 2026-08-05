/**
 * The spoken-expression tags, shared between processes.
 *
 * One home for the list: main's synthesiser keeps the known tags and drops
 * invented ones; the renderer strips them all from the visible transcript.
 * Two copies of this regex would drift, and a drifted copy reads
 * "less-than laugh" aloud or prints it into the chat.
 */

/**
 * The expression tags that SURVIVED the live Russian test (2026-08-05, all
 * ten of discussion #6 tried in every position, doubled and tripled):
 *
 *   - laugh, breath, sigh, cough, sad — performed, but reliably only when
 *     DOUBLED and at the start of a sentence or after its final period;
 *     single tags are a coin-flip, mid-sentence is a dead zone.
 *   - scream — works only hugging a short interjection: <scream> Ааа <scream>.
 *   - surprise, angry, throatclear, yawn — NEVER performed in Russian, the
 *     voice reads them out as English words. They are stripped before
 *     synthesis; the model is told not to use them at all.
 */
export const TTS_TAGS = [
  "<laugh>",
  "<sigh>",
  "<breath>",
  "<cough>",
  "<sad>",
  "<scream>",
] as const;

/**
 * Split off expression tags for display: the UI hides them, the voice keeps
 * them. Unknown look-alike tags (<whisper>…) are dropped from BOTH — reading
 * "less-than whisper" aloud is worse than losing the nuance.
 */
export function stripTtsTags(text: string): string {
  return text
    .replace(
      /<\/?(?:laugh|sigh|breath|surprise|scream|throatclear|sad|angry|cough|yawn|pause|whisper|slow|fast|loud|quiet|chuckle|gasp|giggle|cry|hmm)>/gi,
      "",
    )
    .replace(/[ \t]{2,}/g, " ");
}

/** What the synthesiser should see: known tags kept, unknown ones removed,
 * and the reliable ones normalised to the form that actually lands. */
export function textForSpeech(text: string): string {
  const known = new Set(TTS_TAGS.map((t) => t.toLowerCase()));
  let t = text
    .replace(/<\/?[a-z_]{2,12}>/gi, (m) => {
      const bare = m.replace("/", "").toLowerCase();
      return known.has(bare) ? bare : "";
    })
    // Field-tested: a single tag is a coin-flip, a doubled one lands.
    // Any run of the same tag becomes exactly two — except <scream>,
    // whose only working shape is single tags hugging an interjection.
    .replace(/(<(laugh|sigh|breath|cough|sad)>)(\s*<\2>)*/gi, "$1$1");
  // A tag run at the VERY START of the input gets read, not performed
  // (paragraph-initial <breath><breath> says "breath" once; the same
  // pair after any sentence breathes — both ru and fr). Shift it past
  // the first sentence; a one-sentence chunk carries it at the end.
  // <scream> stays put: its interjection hug must not be rearranged.
  const lead = t.match(/^\s*((?:<(?:laugh|sigh|breath|cough|sad)>\s*)+)/iu);
  if (lead) {
    const run = lead[1].replace(/\s+/g, "");
    const rest = t.slice(lead[0].length);
    const dot = rest.search(/[.!?…]/u);
    t =
      dot >= 0
        ? `${rest.slice(0, dot + 1)} ${run}${rest.slice(dot + 1)}`
        : rest.trim()
          ? `${rest.trim()} ${run}`
          : run;
  }
  return t.replace(/[ \t]{2,}/g, " ");
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
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/(^|\s)-{3,}(\s|$)/g, " ")
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

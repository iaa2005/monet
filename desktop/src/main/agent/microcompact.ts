/**
 * Micro-compaction — reclaim context without losing any of the conversation.
 *
 * Summarising is lossy and expensive: it costs a model call and replaces real
 * turns with prose. Most of the time the context isn't full of conversation at
 * all, it's full of tool OUTPUT — a 200KB file read, a long grep, a build log.
 * Those are replayable: the model can call the tool again if it needs them.
 *
 * So before summarising anything, clear old tool results from replayable tools
 * and see whether that alone gets us under the threshold. Nothing the user or
 * the model SAID is touched.
 */

import type { LLMContentBlock, LLMMessage } from "../llm/adapter.js";

/**
 * Tools whose output can be re-obtained by calling them again. Deliberately
 * excludes anything whose result is a one-off: a sub-agent's report, a
 * question the user answered, a sandbox run with side effects.
 */
const REPLAYABLE_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "PowerShell",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "SandboxRead",
  "SandboxList",
  "ListMcpResources",
  "ReadMcpResource",
]);

export const CLEARED_MARKER = "[Old tool result cleared to save context — call the tool again if you need it]";

/** Rough token estimate for one block's payload. */
function blockChars(block: LLMContentBlock): number {
  if (block.type === "tool_result") {
    if (typeof block.content === "string") return block.content.length;
    return block.content.reduce(
      (n, b) =>
        n + (b.type === "text" ? b.text.length : b.source.data.length),
      0,
    );
  }
  if (block.type === "text") return block.text.length;
  if ("source" in block && block.source?.data) return block.source.data.length;
  return 0;
}

export interface MicroCompactResult {
  messages: LLMMessage[];
  /** Characters reclaimed (0 when nothing was eligible). */
  charsSaved: number;
  /** How many tool results were cleared. */
  cleared: number;
}

/**
 * Clear replayable tool results older than the protected tail.
 *
 * Counted by MESSAGE POSITION, not by number of results — and that was tested
 * against the upstream rule rather than assumed. services/compact/microCompact.ts
 * protects `compactableIds.slice(-keepRecent)`: the newest N results wherever
 * they are. Ported here it made things worse, and a probe said so in one line:
 * with a single large read followed by eight messages of conversation, the count
 * rule protects it (there is only one result, so it is among the newest N) while
 * the position rule clears it. This pass only runs when the context is ALREADY
 * over the threshold, so protecting the one thing that could be reclaimed means
 * paying for a summary instead.
 *
 * The count rule differs from the tail rule ONLY by protecting results outside
 * the tail. Inside the tail, position already protects everything. So it adds no
 * guarantee we lack and one we do not want. Upstream needs it because its
 * thresholds come from count-based remote config and it has no notion of a tail;
 * we have the tail.
 *
 * @param keepRecentToolResults results in the last N messages are left alone —
 *        the model is usually still working with those. Floored at 1.
 * @param minChars don't bother clearing a result smaller than this; the marker
 *        itself costs tokens, and clearing a 40-character result is a net loss.
 */
export function microCompact(
  messages: LLMMessage[],
  opts: { keepRecentToolResults?: number; minChars?: number } = {},
): MicroCompactResult {
  const keep = Math.max(1, opts.keepRecentToolResults ?? 6);
  const minChars = opts.minChars ?? 400;

  // Which tool_use ids belong to replayable tools.
  const replayableIds = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && REPLAYABLE_TOOLS.has(block.name))
        replayableIds.add(block.id);
    }
  }

  const cutoff = Math.max(0, messages.length - keep);

  let charsSaved = 0;
  let cleared = 0;

  const out = messages.map((msg, i) => {
    if (i >= cutoff || typeof msg.content === "string") return msg;
    let touched = false;
    const content = msg.content.map((block) => {
      if (
        block.type !== "tool_result" ||
        !replayableIds.has(block.tool_use_id) ||
        block.content === CLEARED_MARKER
      )
        return block;
      const size = blockChars(block);
      if (size < minChars) return block;
      // An error result is kept: it's usually short, and the model needs to
      // see that the call failed rather than think it never happened.
      if (block.is_error) return block;
      touched = true;
      cleared++;
      charsSaved += size - CLEARED_MARKER.length;
      return { ...block, content: CLEARED_MARKER };
    });
    return touched ? { ...msg, content } : msg;
  });

  return { messages: out, charsSaved, cleared };
}

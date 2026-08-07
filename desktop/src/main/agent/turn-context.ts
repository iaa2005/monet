/**
 * Which messages a prompt owns, so it can be taken out of context whole.
 *
 * The arithmetic of "remove this prompt", with no dependencies — the agent
 * holds the messages and decides what a user turn IS (a visible prompt,
 * not a tool_result continuation, not a hidden background delivery), and
 * passes that in. Separate because the rule below is the one that breaks
 * an API call rather than a display, and it should be checkable without
 * booting an agent.
 *
 * THE RULE: a turn is the prompt plus everything up to the next prompt —
 * the reply, its tool calls and their results. An assistant `tool_use`
 * whose `tool_result` is missing, or a `tool_result` with no `tool_use`,
 * is a request the API rejects outright, so a half-removed turn is not a
 * cosmetic mistake.
 */

/** The half-open range [start, end) a prompt at `start` owns. */
export function turnRange<T>(
  messages: T[],
  start: number,
  isBoundary: (m: T) => boolean,
): { start: number; end: number } | null {
  if (start < 0 || start >= messages.length) return null;
  if (!isBoundary(messages[start])) return null;
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    if (isBoundary(messages[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Every tool_use id in `messages` that has no matching tool_result, and
 * every tool_result with no tool_use.
 *
 * The invariant, stated as a function so it can be asserted rather than
 * hoped for: run it over whatever is about to be sent and it must be
 * empty.
 */
export function danglingToolIds(
  messages: { content: unknown }[],
): { uses: string[]; results: string[] } {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as {
      type?: string;
      id?: string;
      tool_use_id?: string;
    }[]) {
      if (block.type === "tool_use" && block.id) uses.add(block.id);
      if (block.type === "tool_result" && block.tool_use_id)
        results.add(block.tool_use_id);
    }
  }
  return {
    uses: [...uses].filter((id) => !results.has(id)),
    results: [...results].filter((id) => !uses.has(id)),
  };
}

/**
 * Per-session "revealed" tool set for ToolSearch (deferred tool loading).
 *
 * When ToolSearch is enabled, MCP connector tools are NOT advertised upfront
 * (they can be many and verbose — pure context cost). The model calls
 * ToolSearch to find the ones it needs; the matches are recorded here and then
 * advertised on the next turn, so the model can actually call them.
 *
 * Kept in its own module so both vendor-tools (reader) and the ToolSearch tool
 * (writer) can import it without a cycle.
 */

const revealedBySession = new Map<string, Set<string>>();

export function revealTools(sessionId: string, names: string[]): void {
  const set = revealedBySession.get(sessionId) ?? new Set<string>();
  for (const n of names) set.add(n);
  revealedBySession.set(sessionId, set);
}

export function getRevealedTools(sessionId: string): Set<string> {
  return revealedBySession.get(sessionId) ?? new Set<string>();
}

export function clearRevealedTools(sessionId: string): void {
  revealedBySession.delete(sessionId);
}

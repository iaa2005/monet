/**
 * Background sub-agents.
 *
 * A Task launched with run_in_background runs detached from the parent turn:
 * the parent gets an immediate "launched" result and keeps working, while the
 * child runs under its OWN AbortController (not the turn's — a new user send
 * aborts the turn, and background work must survive that).
 *
 * Two pieces of per-session state:
 *  - `running`: the live controllers, so chat:abort / chat:reset can stop them.
 *  - `pending`: finished reports waiting to be folded into the next user turn
 *    (kept out of the live history until a turn boundary so user/assistant
 *    alternation isn't broken mid-turn).
 */

const running = new Map<string, Set<AbortController>>();
const pending = new Map<string, string[]>();

export function registerBgAgent(
  sessionId: string,
  controller: AbortController,
): void {
  const set = running.get(sessionId) ?? new Set<AbortController>();
  set.add(controller);
  running.set(sessionId, set);
}

export function unregisterBgAgent(
  sessionId: string,
  controller: AbortController,
): void {
  running.get(sessionId)?.delete(controller);
}

/** Stop every background agent for a session (chat:abort / chat:reset). */
export function abortBgAgents(sessionId: string): void {
  const set = running.get(sessionId);
  if (set) {
    for (const c of set) c.abort();
    set.clear();
  }
  pending.delete(sessionId);
}

/** Stop every background agent across all sessions (chat:abort with no id). */
export function abortAllBgAgents(): void {
  for (const set of running.values()) {
    for (const c of set) c.abort();
    set.clear();
  }
  pending.clear();
}

/** How many background agents are still running for a session. */
export function countRunningBgAgents(sessionId: string): number {
  return running.get(sessionId)?.size ?? 0;
}

/** Queue a finished report to be delivered to the model on the next turn. */
export function pushBgResult(
  sessionId: string,
  agentType: string,
  description: string,
  report: string,
): void {
  const label = description ? `"${agentType}" (${description})` : `"${agentType}"`;
  const note =
    `<system-reminder>\nA background sub-agent ${label} has finished. ` +
    `Its report:\n\n${report}\n</system-reminder>`;
  const arr = pending.get(sessionId) ?? [];
  arr.push(note);
  pending.set(sessionId, arr);
}

/** Take and clear the pending background reports for a session. */
export function drainBgResults(sessionId: string): string[] {
  const arr = pending.get(sessionId);
  if (!arr || arr.length === 0) return [];
  pending.delete(sessionId);
  return arr;
}

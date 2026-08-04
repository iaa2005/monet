/**
 * Mid-turn injection — say something to the agent while it is still working.
 *
 * The composer could only QUEUE a message: it sat until the run finished and
 * then started a new turn. That is the wrong shape for the case it is needed
 * most — the agent is three tool calls into the wrong approach and you want to
 * say so NOW, not after it finishes being wrong.
 *
 * Kimi Code binds this to Ctrl-S. Same idea here.
 *
 * Where the text lands is not free. A conversation with tool calls has a rigid
 * shape: an assistant message carrying `tool_use` blocks MUST be followed by a
 * user message carrying the matching `tool_result` blocks, or the API rejects
 * the request. So an injection is appended as a text block to THAT message,
 * after the results — the one slot in a running turn where user text is legal.
 * The same trick the background-report delivery already uses.
 */

/** Pending text per session, in the order it was typed. */
const pending = new Map<string, string[]>();

/** Sessions with a run in flight — only those can take an injection. */
const running = new Set<string>();

export function markRunning(sessionId: string): void {
  running.add(sessionId);
}

export function markStopped(sessionId: string): void {
  running.delete(sessionId);
  // Anything undelivered dies with the run. Carrying it into the NEXT turn
  // would surface a stale correction against work that already changed.
  pending.delete(sessionId);
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/**
 * Offer text to a running turn.
 *
 * Returns false when the session is idle, so the caller can fall back to an
 * ordinary send instead of dropping the message — the user pressed a key, and
 * something must happen.
 */
export function injectMessage(sessionId: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !running.has(sessionId)) return false;
  const list = pending.get(sessionId);
  if (list) list.push(trimmed);
  else pending.set(sessionId, [trimmed]);
  return true;
}

/** Take everything pending for this session (empty array when there is none). */
export function drainInjections(sessionId: string): string[] {
  const list = pending.get(sessionId);
  if (!list?.length) return [];
  pending.delete(sessionId);
  return list;
}

export function hasInjections(sessionId: string): boolean {
  return (pending.get(sessionId)?.length ?? 0) > 0;
}

/**
 * How injected text reads to the model.
 *
 * Marked as arriving mid-turn and marked as the user's: without that framing a
 * bare sentence after a pile of tool results reads like part of the results,
 * and a correction that is mistaken for tool output is worse than no
 * correction at all.
 */
export function formatInjection(notes: string[]): string {
  const body = notes.join("\n\n");
  // Steering, not a brake: listen, but keep the goal. Only an explicit
  // "stop" or redirect abandons the current plan.
  return (
    `[The user said this WHILE you were working — steering, not tool ` +
    `output. Weigh it into your next step, but KEEP PURSUING your current ` +
    `objective unless it explicitly tells you to stop or change course. ` +
    `Do not restart work that is already done.]\n\n${body}`
  );
}

/**
 * Which space a chat belongs to — asked of the database, not of the caller.
 *
 * The space decides whether the file tools address this chat's sandbox or the
 * user's disk, which makes it a security boundary rather than a display
 * preference. It used to arrive as a parameter on the IPC call that starts a
 * turn: the renderer said "home" or "code" and main believed it. Everything
 * downstream — which tools are advertised, which one `Read` resolves to —
 * hung off a value that travelled through the UI.
 *
 * It hangs off the session row now. A chat is created with its space and the
 * row is the only place that records it, so nothing in the renderer can move
 * an existing Home chat onto the disk.
 *
 * The caller's value is kept as a fallback for the one case where there is no
 * row to ask: prompt seeding and other startup paths that have no session at
 * all. Those advertise a toolset to nobody.
 */

import { getSessionStore } from "../session/store.js";

export function sessionSpace(
  sessionId: string | undefined,
  requested?: string,
): string | undefined {
  if (!sessionId) return requested;
  try {
    const row = getSessionStore().get(sessionId);
    if (row?.space) return row.space;
  } catch {
    // No store yet (early startup, or a probe running the agent standalone).
  }
  return requested;
}

/** True when this chat's file tools mean the sandbox. */
export function isSandboxSpace(
  sessionId: string | undefined,
  requested?: string,
): boolean {
  return sessionSpace(sessionId, requested) === "home";
}

/**
 * Per-session permission-mode override.
 *
 * The mode is chosen in the renderer and passed into runAgent once, at the top
 * of a turn. Approving a plan has to change it in the MIDDLE of a turn — the
 * whole point is that the model carries straight on and starts editing — so
 * the tool executor consults this override on every call rather than trusting
 * the value captured at send time.
 *
 * The renderer updates its own selector on approval too; this only has to
 * carry the rest of the current turn.
 */

import type { UiPermissionMode } from "./vendor-tools.js";

const overrides = new Map<string, UiPermissionMode>();

export function setSessionMode(sessionId: string, mode: UiPermissionMode): void {
  overrides.set(sessionId, mode);
}

/**
 * The mode a tool call should actually run under. An override only ever
 * applies while the requested mode is still "plan": once the user (or the next
 * turn) moves off plan mode, their selector wins and the stale override is
 * dropped, so an approval can't silently outlive the plan it approved.
 */
export function effectiveMode(
  sessionId: string,
  requested: UiPermissionMode,
): UiPermissionMode {
  const override = overrides.get(sessionId);
  if (!override) return requested;
  if (requested !== "plan") {
    overrides.delete(sessionId);
    return requested;
  }
  return override;
}

export function clearSessionMode(sessionId: string): void {
  overrides.delete(sessionId);
}

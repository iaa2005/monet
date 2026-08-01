/**
 * Per-session permission-mode override.
 *
 * The mode is chosen in the renderer and passed into runAgent once, at the top
 * of a turn. Two things change it in the MIDDLE of a turn: approving a plan
 * (plan → default/acceptEdits, so the model can start editing immediately)
 * and the EnterPlanMode tool (anything → plan, when the user asks for a plan
 * in prose and the model switches itself). The tool executor consults this
 * override on every call rather than trusting the value captured at send
 * time.
 *
 * The override remembers WHICH renderer-requested mode it was set under: as
 * long as the selector still reads that value, the override wins; the moment
 * the user flips the selector to anything else, their choice does — a stale
 * override must not outlive the situation that created it.
 */

import type { UiPermissionMode } from "./vendor-tools.js";

interface Override {
  mode: UiPermissionMode;
  /** The renderer's requested mode at the time the override was set. */
  setUnder: UiPermissionMode;
}

const overrides = new Map<string, Override>();

export function setSessionMode(
  sessionId: string,
  mode: UiPermissionMode,
  setUnder: UiPermissionMode = "plan",
): void {
  overrides.set(sessionId, { mode, setUnder });
}

/** The mode a tool call should actually run under. */
export function effectiveMode(
  sessionId: string,
  requested: UiPermissionMode,
): UiPermissionMode {
  const override = overrides.get(sessionId);
  if (!override) return requested;
  if (requested !== override.setUnder) {
    // The user moved the selector since — their choice wins from here on.
    overrides.delete(sessionId);
    return requested;
  }
  return override.mode;
}

export function clearSessionMode(sessionId: string): void {
  overrides.delete(sessionId);
}

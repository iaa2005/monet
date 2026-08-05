/**
 * Goal IPC — start, inspect and stop a session's autonomous objective.
 *
 * Starting a goal does NOT run it: it writes the record and returns. The turn
 * that follows is an ordinary chat send, and the driver takes over from there
 * (see agent/goal/driver.ts). Keeping those separate means a goal cannot begin
 * working before the user has seen it on screen.
 */

import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import {
  createGoal,
  pauseGoal,
  resumeGoal,
  type Goal,
} from "../agent/goal/state.js";
import { clearGoal, loadGoal, saveGoal } from "../agent/goal/store.js";

export interface GoalStartInput {
  objective: string;
  completionCriterion?: string;
  connectorGrants?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

/**
 * Record the workspace's current checkpoint as the goal's baseline — what the
 * completion judge diffs against. Fire-and-forget: registration stays sync
 * (the goal must be on screen before it starts working), and a goal without a
 * baseline just gives its judge one piece of evidence less.
 */
function recordBaseline(sid: string, goalId: string): void {
  void (async () => {
    try {
      const { getSessionStore } = await import("../session/store.js");
      const { getWorkspacePath } = await import("./workspace.js");
      const { currentCheckpoint } = await import("../agent/checkpoints.js");
      const workspace =
        getSessionStore().get(sid)?.workspace || getWorkspacePath();
      const sha = await currentCheckpoint(sid, workspace);
      if (!sha) return;
      const goal = loadGoal(sid);
      if (goal && goal.id === goalId && !goal.baselineSha)
        saveGoal(sid, { ...goal, baselineSha: sha });
    } catch {
      /* evidence, not a requirement */
    }
  })();
}

/**
 * Start a goal typed as `/goal <objective>` in the composer.
 *
 * No connector grants: a goal started by typing has none, and every outward
 * action asks. Granting them up front is a deliberate choice, so it belongs in
 * a dialog the user filled in — not in a sentence they typed quickly.
 */
export function registerGoalFromChat(
  sessionId: string,
  objective: string,
): { ok: boolean; error?: string } {
  const sid = sessionId || "default";
  const result = createGoal(
    loadGoal(sid),
    { objective },
    new Date(),
    randomUUID(),
  );
  if (!result.ok) return { ok: false, error: result.error };
  saveGoal(sid, result.goal);
  recordBaseline(sid, result.goal.id);
  return { ok: true };
}

export function registerGoalIPC(): void {
  ipcMain.handle("goal:get", (_e, sessionId: string): Goal | null =>
    loadGoal(sessionId || "default"),
  );

  ipcMain.handle(
    "goal:start",
    (
      _e,
      sessionId: string,
      input: GoalStartInput,
    ): { ok: boolean; goal?: Goal; error?: string } => {
      const sid = sessionId || "default";
      const result = createGoal(loadGoal(sid), input, new Date(), randomUUID());
      if (!result.ok) return { ok: false, error: result.error };
      saveGoal(sid, result.goal);
      recordBaseline(sid, result.goal.id);
      return { ok: true, goal: result.goal };
    },
  );

  ipcMain.handle("goal:pause", (_e, sessionId: string): Goal | null => {
    const sid = sessionId || "default";
    const goal = loadGoal(sid);
    if (!goal) return null;
    const next = pauseGoal(goal, new Date(), "user");
    saveGoal(sid, next);
    return next;
  });

  ipcMain.handle("goal:resume", (_e, sessionId: string): Goal | null => {
    const sid = sessionId || "default";
    const goal = loadGoal(sid);
    if (!goal) return null;
    const next = resumeGoal(goal, new Date());
    saveGoal(sid, next);
    return next;
  });

  // Cancel deletes. There is no `cancelled` state to inspect afterwards: a
  // tombstone would be one more thing for the model to reason about, and the
  // user's intent is simply that the goal stop existing.
  ipcMain.handle("goal:cancel", (_e, sessionId: string): { ok: boolean } => {
    clearGoal(sessionId || "default");
    return { ok: true };
  });
}

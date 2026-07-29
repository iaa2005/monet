/**
 * Goal persistence — one goal per session, on disk.
 *
 * On disk rather than in memory because a goal outlives the process: closing
 * the app mid-goal and reopening should show it, paused, rather than lose it.
 * A goal restored from disk is never `active` — see loadGoal.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../../data-dir.js";
import type { Goal } from "./state.js";

function goalsDir(): string {
  const dir = join(getDataDir(), "goals");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function goalPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  return join(goalsDir(), `${safe}.json`);
}

/** In-memory mirror, so the driver does not read the disk between turns. */
const cache = new Map<string, Goal | null>();

/**
 * The session's goal, or null.
 *
 * A goal read from disk for the first time is forced to `paused`, whatever it
 * said. `active` means "a driver is taking turns for this right now", and
 * after a restart no driver is running — leaving it active would either strand
 * the record or, worse, have the next message silently resume autonomous work
 * the user has not asked for since the app reopened.
 */
export function loadGoal(sessionId: string): Goal | null {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  let goal: Goal | null = null;
  try {
    const f = goalPath(sessionId);
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, "utf-8")) as Goal;
      goal =
        parsed.status === "active"
          ? {
              ...parsed,
              status: "paused",
              stopReason: "session-resumed",
              stopDetail: "The app restarted while this goal was running.",
            }
          : parsed;
    }
  } catch {
    goal = null;
  }
  cache.set(sessionId, goal);
  return goal;
}

export function saveGoal(sessionId: string, goal: Goal): void {
  cache.set(sessionId, goal);
  try {
    writeFileSync(goalPath(sessionId), JSON.stringify(goal, null, 2), "utf-8");
  } catch {
    /* the in-memory copy still drives this run */
  }
}

export function clearGoal(sessionId: string): void {
  cache.set(sessionId, null);
  try {
    rmSync(goalPath(sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

/** Forget the cached copy (session reset), leaving the file alone. */
export function dropGoalCache(sessionId: string): void {
  cache.delete(sessionId);
}

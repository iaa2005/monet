/**
 * Everything a chat owns, forgotten in one place.
 *
 * A chat spreads across a lot of stores — DB tables in two modules, three
 * directories, a JSON file per store, an engine override — and deleting one
 * used to mean remembering all of them at the call site. It didn't: deleting
 * a chat removed its row, its messages (foreign-key cascade) and its plans,
 * and left the transcript behind. Measured on a real install: 8545 transcript
 * rows and 108 context events from 463 chats that no longer existed, 11.8 MB
 * of a 44 MB database.
 *
 * So there is one function, and both callers — deleting a chat, and closing
 * an incognito one — go through it. A store added later has exactly one place
 * to be registered, and `sweepOrphans()` at startup is the safety net for
 * whatever a crash (or a past version) left behind.
 */

import { existsSync, rmSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import { getSessionDb } from "./store.js";
import { clearTranscript } from "./transcript.js";
import { clearUiState } from "./ui-state.js";
import { sessionSlug } from "../agent/checkpoint-store.js";
import { clearGoal, dropGoalCache } from "../agent/goal/store.js";
import { clearSessionEngine } from "../sandbox/config.js";
import { closeSessionTerminals } from "../terminal/sessions.js";

function rmDir(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[purge] failed to remove ${path}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
/**
 * Forget one chat's data — everything except its `sessions` row, which the
 * caller owns (deleting a chat removes it; closing an incognito chat never
 * had one).
 *
 * What the agent holds IN MEMORY for a chat — its model history, its token
 * usage, its file ledgers — is not freed here, deliberately: this module is
 * about durable stores, and importing the agent to reach a WeakMap would drag
 * the whole tool pipeline into a function that deletes rows. The lifecycle
 * owners do it — `sessions:delete` calls forgetSession(), and incognito's
 * close calls resetConversation().
 */
export function purgeSessionData(sessionId: string): void {
  if (!sessionId) return;

  // ── The live shells ───────────────────────────────────────────────
  // A terminal deliberately outlives its panel, so nothing else would ever
  // end one: deleting the chat would leave containers running against a /work
  // directory this function is about to delete out from under them. A chat can
  // hold several, so all of them go.
  closeSessionTerminals(sessionId);

  // ── The database ──────────────────────────────────────────────────
  // Transcript + context events live in the transcript store's tables, which
  // have no foreign key to sessions (they are created lazily, and adding one
  // to an existing table means rebuilding it).
  clearTranscript(sessionId);
  try {
    getSessionDb()
      .prepare("DELETE FROM plans WHERE session_id = ?")
      .run(sessionId);
  } catch {
    /* plans table not created yet */
  }

  // ── Files ─────────────────────────────────────────────────────────
  clearUiState(sessionId);
  clearGoal(sessionId);
  dropGoalCache(sessionId);
  clearSessionEngine(sessionId);

  const safe = sessionSlug(sessionId);
  for (const root of ["artifacts", "sandboxes", "checkpoints"])
    rmDir(join(getDataSubdir(root), safe));
}

/**
 * Startup sweep: rows whose chat no longer exists.
 *
 * Deliberately startup-only. An incognito chat has no `sessions` row while it
 * runs, so a sweep during a session would delete a live conversation's
 * transcript; at startup nothing is in flight.
 */
export function sweepOrphans(): { transcript: number; events: number } {
  try {
    const db = getSessionDb();
    const del = (table: string): number => {
      try {
        const r = db
          .prepare(
            `DELETE FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`,
          )
          .run();
        return Number(r.changes ?? 0);
      } catch {
        return 0; // table not created yet
      }
    };
    const transcript = del("transcript");
    const events = del("context_events");
    const plans = del("plans");
    if (transcript + events + plans > 0)
      console.log(
        `[purge] swept ${transcript} transcript rows, ${events} context events, ${plans} plans from deleted chats`,
      );
    return { transcript, events };
  } catch {
    return { transcript: 0, events: 0 };
  }
}

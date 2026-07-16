/**
 * One-time migration: give pre-existing chats a durable transcript.
 *
 * Chats created before the transcript store have only display rows (SQLite
 * `messages`). This reconstructs a TEXT-ONLY model transcript from them (the
 * tool_use/tool_result blocks weren't persisted, so full fidelity isn't
 * recoverable — that's fine, new chats build the real thing natively). Runs in
 * the app process because better-sqlite3 is built for Electron's ABI (a plain
 * `node` script can't open the DB); a marker file makes the auto-run one-shot,
 * and Settings → Advanced can force a re-run.
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./data-dir.js";
import { getSessionStore } from "./session-store.js";
import { hasTranscript, replaceTranscript } from "./transcript-store.js";

function markerPath(): string {
  return join(getDataDir(), "transcripts-migrated.json");
}

export function migrateTranscripts(): { migrated: number; skipped: number } {
  const store = getSessionStore();
  const sessions = store.list(1_000_000, 0, undefined, "all");
  let migrated = 0;
  let skipped = 0;
  for (const sess of sessions) {
    if (hasTranscript(sess.id)) {
      skipped++;
      continue;
    }
    const full = store.get(sess.id);
    const prior = (full?.messages ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && !!m.content)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    if (prior.length > 0) {
      replaceTranscript(sess.id, prior);
      migrated++;
    } else {
      skipped++;
    }
  }
  try {
    writeFileSync(
      markerPath(),
      JSON.stringify({ at: new Date().toISOString(), migrated, skipped }),
    );
  } catch {
    /* marker is best-effort */
  }
  return { migrated, skipped };
}

/** Auto-run once (guarded by the marker). Safe to call on every startup. */
export function migrateTranscriptsOnce(): void {
  try {
    if (existsSync(markerPath())) return;
    migrateTranscripts();
  } catch {
    /* never block startup on migration */
  }
}

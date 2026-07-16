/**
 * Transcript store — the durable, full-fidelity model-facing history.
 *
 * Unlike the display messages (SQLite `messages`, for the UI), this persists the
 * exact LLMMessage[] the agent sends — assistant text + tool_use blocks, user
 * tool_result blocks — so a reopened chat continues with the SAME context the
 * model had, not a text-only reconstruction (this is what Claude Code's JSONL
 * transcript gives; we keep it in the same SQLite DB alongside our display rows).
 *
 * A sibling `context_events` log records structural mutations — compaction
 * (with BEFORE and AFTER snapshots), rewinds, notable commands — so the context
 * can be time-travelled: e.g. "rewind through a compaction" restores the
 * pre-compaction transcript from the event's `before` snapshot.
 */

import { randomUUID } from "node:crypto";
import { getSessionDb } from "./session-store.js";
import type { LLMMessage } from "./llm/adapter.js";

export type ContextEventType = "compact" | "rewind" | "command";

export interface ContextEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: ContextEventType;
  at: string;
  /** Type-specific data. For `compact`: { before, after, beforeTokens, afterTokens }. */
  payload: Record<string, unknown>;
}

let ready = false;
function db(): ReturnType<typeof getSessionDb> {
  const d = getSessionDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id);
      CREATE TABLE IF NOT EXISTS context_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ctxevents_session ON context_events(session_id);
    `);
    // Upgrade a transcript table created before the `hidden` column (marks
    // no-display-bubble turns like background-delivery so rewind counts align).
    const cols = d.prepare("PRAGMA table_info(transcript)").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "hidden"))
      d.exec("ALTER TABLE transcript ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    ready = true;
  }
  return d;
}

// ─── Transcript ─────────────────────────────────────────────────────────────

export function loadTranscript(sessionId: string): LLMMessage[] {
  return loadTranscriptWithMeta(sessionId).messages;
}

/** Load the transcript plus each message's `hidden` flag (turns with no display
 * bubble, e.g. background-delivery), so the in-memory tagging can be restored. */
export function loadTranscriptWithMeta(sessionId: string): {
  messages: LLMMessage[];
  hidden: boolean[];
} {
  try {
    const rows = db()
      .prepare(
        "SELECT role, content, hidden FROM transcript WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as { role: string; content: string; hidden: number }[];
    return {
      messages: rows.map((r) => ({
        role: r.role as LLMMessage["role"],
        content: JSON.parse(r.content) as LLMMessage["content"],
      })),
      hidden: rows.map((r) => r.hidden === 1),
    };
  } catch {
    return { messages: [], hidden: [] };
  }
}

export function hasTranscript(sessionId: string): boolean {
  try {
    const row = db()
      .prepare("SELECT 1 FROM transcript WHERE session_id = ? LIMIT 1")
      .get(sessionId);
    return !!row;
  } catch {
    return false;
  }
}

/** Replace a session's transcript wholesale (the agent write-through / rewrite
 * after compaction or rewind). Cheap enough per turn — chats are small. */
export function replaceTranscript(
  sessionId: string,
  messages: LLMMessage[],
  hidden?: boolean[],
): void {
  try {
    const d = db();
    const tx = d.transaction(() => {
      d.prepare("DELETE FROM transcript WHERE session_id = ?").run(sessionId);
      const insert = d.prepare(
        "INSERT INTO transcript (session_id, seq, role, content, hidden) VALUES (?, ?, ?, ?, ?)",
      );
      messages.forEach((m, i) =>
        insert.run(
          sessionId,
          i,
          m.role,
          JSON.stringify(m.content),
          hidden?.[i] ? 1 : 0,
        ),
      );
    });
    tx();
  } catch {
    /* best-effort persistence — a failed write never breaks a run */
  }
}

export function clearTranscript(sessionId: string): void {
  try {
    const d = db();
    d.prepare("DELETE FROM transcript WHERE session_id = ?").run(sessionId);
    d.prepare("DELETE FROM context_events WHERE session_id = ?").run(sessionId);
  } catch {
    /* ignore */
  }
}

// ─── Context events ─────────────────────────────────────────────────────────

export function recordContextEvent(
  sessionId: string,
  type: ContextEventType,
  payload: Record<string, unknown>,
): ContextEvent | null {
  try {
    const d = db();
    const seqRow = d
      .prepare(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM context_events WHERE session_id = ?",
      )
      .get(sessionId) as { next: number };
    const ev: ContextEvent = {
      id: randomUUID(),
      sessionId,
      seq: seqRow.next,
      type,
      at: new Date().toISOString(),
      payload,
    };
    d.prepare(
      "INSERT INTO context_events (id, session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ev.id, sessionId, ev.seq, ev.type, ev.at, JSON.stringify(payload));
    return ev;
  } catch {
    return null;
  }
}

export function listContextEvents(sessionId: string): ContextEvent[] {
  try {
    const rows = db()
      .prepare(
        "SELECT id, session_id, seq, type, at, payload FROM context_events WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as {
      id: string;
      session_id: string;
      seq: number;
      type: string;
      at: string;
      payload: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as ContextEventType,
      at: r.at,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  } catch {
    return [];
  }
}

export function getContextEvent(
  sessionId: string,
  eventId: string,
): ContextEvent | null {
  return listContextEvents(sessionId).find((e) => e.id === eventId) ?? null;
}

/** Drop every context event at or after `seq` (e.g. after undoing a compaction,
 * the later events no longer describe the live transcript). */
export function dropContextEventsFrom(sessionId: string, seq: number): void {
  try {
    db()
      .prepare("DELETE FROM context_events WHERE session_id = ? AND seq >= ?")
      .run(sessionId, seq);
  } catch {
    /* ignore */
  }
}

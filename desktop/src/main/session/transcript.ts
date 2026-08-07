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
import { getSessionDb } from "./store.js";
import type { LLMMessage } from "../llm/adapter.js";

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
        -- Stable across saves, and the same id the display side uses where
        -- the two describe the same message. See the migration below.
        msg_id TEXT,
        -- 0 once something took it out of the model's context (a compaction,
        -- an undone prompt, a prompt removed by hand). The row stays.
        in_context INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_msgid
        ON transcript(session_id, msg_id);
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
    // A STABLE IDENTITY for a model message, and whether the model can still
    // read it.
    //
    // This table was keyed by position alone — (session_id, seq) — and every
    // save deleted the session's rows and re-inserted them renumbered. So a
    // message had no identity, the display side (which does have ids) could
    // only be related to it by COUNTING user turns, and because this side
    // also gets truncated by compaction and undo, the chat had to
    // reconstruct "what is still in context" by replaying the arithmetic of
    // every past operation.
    //
    // With an id and a flag, all of that becomes a lookup: out-of-context is
    // a property of a message rather than a range to be derived, and it is
    // reversible, which a truncation is not.
    if (!cols.some((c) => c.name === "msg_id"))
      d.exec("ALTER TABLE transcript ADD COLUMN msg_id TEXT");
    if (!cols.some((c) => c.name === "in_context"))
      d.exec(
        "ALTER TABLE transcript ADD COLUMN in_context INTEGER NOT NULL DEFAULT 1",
      );
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
  ids: (string | null)[];
  inContext: boolean[];
} {
  try {
    const rows = db()
      .prepare(
        "SELECT role, content, hidden, msg_id, in_context FROM transcript WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as {
      role: string;
      content: string;
      hidden: number;
      msg_id: string | null;
      in_context: number;
    }[];
    return {
      messages: rows.map((r) => ({
        role: r.role as LLMMessage["role"],
        content: JSON.parse(r.content) as LLMMessage["content"],
      })),
      hidden: rows.map((r) => r.hidden === 1),
      ids: rows.map((r) => r.msg_id),
      inContext: rows.map((r) => r.in_context !== 0),
    };
  } catch {
    return { messages: [], hidden: [], ids: [], inContext: [] };
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
  meta?: { ids?: (string | null)[]; inContext?: boolean[] },
): void {
  try {
    const d = db();
    const tx = d.transaction(() => {
      // Identity has to survive the rewrite. This still deletes and
      // re-inserts — the whole array is the unit the agent holds in memory —
      // but the id and the context flag ride along per message instead of
      // being invented anew, which is what makes them stable.
      d.prepare("DELETE FROM transcript WHERE session_id = ?").run(sessionId);
      const insert = d.prepare(
        "INSERT INTO transcript (session_id, seq, role, content, hidden, msg_id, in_context) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      messages.forEach((m, i) =>
        insert.run(
          sessionId,
          i,
          m.role,
          JSON.stringify(m.content),
          hidden?.[i] ? 1 : 0,
          meta?.ids?.[i] ?? null,
          meta?.inContext?.[i] === false ? 0 : 1,
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

/**
 * Replace a session's context-event log with a recorded one (import).
 *
 * Verbatim — ids, seq and timestamps included: the log is a history, and a
 * history renumbered on arrival is a different history. `undoCompact` looks
 * events up by id, so those have to survive too.
 */
export function replaceContextEvents(
  sessionId: string,
  events: ContextEvent[],
): void {
  try {
    const d = db();
    const tx = d.transaction(() => {
      d.prepare("DELETE FROM context_events WHERE session_id = ?").run(sessionId);
      const insert = d.prepare(
        "INSERT INTO context_events (id, session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const ev of events) {
        const args = [
          sessionId,
          ev.seq,
          ev.type,
          ev.at,
          JSON.stringify(ev.payload ?? {}),
        ] as const;
        // The id is kept when it is free — but ids are session-local (the UI
        // re-reads them), and importing a chat back into the install it came
        // from collides on the primary key. A collision must cost one id, not
        // the whole log.
        try {
          insert.run(ev.id, ...args);
        } catch {
          insert.run(randomUUID(), ...args);
        }
      }
    });
    tx();
  } catch {
    /* an unreadable log is not worth failing an import over */
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

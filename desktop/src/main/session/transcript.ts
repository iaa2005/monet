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

export type ContextEventType = "compact" | "rewind";

export interface ContextEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: ContextEventType;
  at: string;
  /** Type-specific data. For `compact`: { before, after, beforeTokens, afterTokens }. */
  payload: Record<string, unknown>;
}

/**
 * One schema, declared once.
 *
 * This used to be a CREATE plus three ALTER TABLEs guarded by a PRAGMA, and
 * the shape of that is what broke it: an index over `msg_id` was declared in
 * the same batch as the table, so on any database that predated the column the
 * whole batch died with "no such column: msg_id" — BEFORE the ALTER that would
 * have added it. `ready` stayed false, every later call re-ran the same failing
 * batch, and the catches below swallowed all of it. The result was no durable
 * transcript and no context events, for every chat, for weeks.
 *
 * The app is not released, so there is no installed base to carry and no
 * reason to keep a second way for this table to come into existence. A
 * database written by an older build simply predates the transcript store —
 * that chat starts its model history fresh, which is what it was doing anyway.
 */
/** Columns this file's statements require. */
const TRANSCRIPT_COLUMNS = [
  "session_id",
  "seq",
  "role",
  "content",
  "hidden",
  "msg_id",
  "in_context",
];

/**
 * A table of the wrong shape is replaced, not patched.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists
 * with fewer columns, and the very next statement — an index over one of the
 * missing ones — then takes the whole batch down. That is the failure this
 * store spent weeks in. So the shape is CHECKED, once, and a table that does
 * not match is dropped: the chats in it lose their model history and start
 * again, which is a cost only a pre-release app can pay, and the alternative
 * is a migration ladder that grows a rung every time a column is added.
 */
function dropIfStale(d: ReturnType<typeof getSessionDb>): void {
  const cols = (
    d.prepare("PRAGMA table_info(transcript)").all() as { name: string }[]
  ).map((c) => c.name);
  if (cols.length === 0) return; // no table yet — nothing to check
  const missing = TRANSCRIPT_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length === 0) return;
  console.warn(
    `[transcript] table is missing ${missing.join(", ")} — rebuilding it; ` +
      `chats written by that build start their model history fresh`,
  );
  d.exec("DROP TABLE transcript");
}

let ready = false;
function db(): ReturnType<typeof getSessionDb> {
  const d = getSessionDb();
  if (!ready) {
    dropIfStale(d);
    d.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        -- A user-role message that is not a PROMPT: a background report, a
        -- mid-run note, a compaction summary. The chat shows no prompt bubble
        -- for these, so Rewind must not count them as user turns.
        hidden INTEGER NOT NULL DEFAULT 0,
        -- Stable across saves, and the same id the display side uses where the
        -- two describe the same message. Identity is what lets "the model
        -- cannot read this" be a property of a message rather than a range
        -- derived by replaying every past compaction — and a property can be
        -- reversed, which a truncation cannot.
        msg_id TEXT,
        -- 0 once something took it out of the model's context (a compaction,
        -- a prompt removed by hand). The row stays.
        in_context INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_msgid ON transcript(session_id, msg_id);
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
    ready = true;
  }
  return d;
}

// ─── Transcript ─────────────────────────────────────────────────────────────

/** Load the transcript plus each message's `hidden` flag (turns with no prompt
 * bubble — background delivery, a mid-run note, a compaction summary), its id
 * and its context flag, so the in-memory tagging can be restored. */
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
  } catch (err) {
    // The most damaging silence of the three: the chat still renders, because
    // the display rows are a different table, so nothing looks wrong — and the
    // model quietly gets a text-only rebuild of a conversation whose tool
    // output it can no longer see.
    complainOnce("loadTranscript", err);
    return { messages: [], hidden: [], ids: [], inContext: [] };
  }
}

/**
 * When this chat last heard from the model, in epoch ms, or null if never.
 *
 * Read from the display rows because that is where timestamps live — the
 * transcript is ordered but not dated. It answers one question: is the server's
 * prompt cache for this conversation still warm? See coldCache().
 */
export function lastAssistantAt(sessionId: string): number | null {
  try {
    const row = db()
      .prepare(
        "SELECT MAX(timestamp) AS at FROM messages WHERE session_id = ? AND role = 'assistant'",
      )
      .get(sessionId) as { at: number | null } | undefined;
    return row?.at ?? null;
  } catch (err) {
    complainOnce("lastAssistantAt", err);
    return null;
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
  } catch (err) {
    /* best-effort persistence — a failed write never breaks a run */
    complainOnce("replaceTranscript", err);
  }
}

/**
 * Say it once, then never again.
 *
 * This file's catches are deliberate — losing a transcript write must not kill a
 * run in progress. But silence turned a one-line schema mistake into weeks of a
 * feature that simply did not exist: no durable transcript for any chat, no
 * context events, and `/compact` quietly doing nothing because there was nothing
 * to compact. The cost of a log line is nothing; the cost of not having one was
 * everything above.
 */
const complained = new Set<string>();
function complainOnce(where: string, err: unknown): void {
  if (complained.has(where)) return;
  complained.add(where);
  console.error(
    `[transcript] ${where} failed and the durable history is now off:`,
    err instanceof Error ? err.message : err,
  );
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

/** A context event without its payload — everything a list needs to draw. */
export interface ContextEventSummary {
  id: string;
  seq: number;
  type: ContextEventType;
  at: string;
  manual: boolean;
  beforeTokens: number | null;
  afterTokens: number | null;
}

/**
 * The event log as a LIST, with the payloads left in the database.
 *
 * Every reader of this log wanted six scalars and got the whole payload
 * parsed for them. That was cheap while a payload was six scalars; it stopped
 * being cheap when compaction started storing what it had folded, and the
 * meter refetches this list every time the conversation grows. json_extract
 * pulls out the fields SQLite can read without handing a megabyte to
 * JSON.parse.
 */
export function listContextEventSummaries(
  sessionId: string,
): ContextEventSummary[] {
  try {
    const rows = db()
      .prepare(
        `SELECT id, seq, type, at,
                json_extract(payload, '$.manual')       AS manual,
                json_extract(payload, '$.beforeTokens') AS beforeTokens,
                json_extract(payload, '$.afterTokens')  AS afterTokens
           FROM context_events
          WHERE session_id = ?
          ORDER BY seq ASC`,
      )
      .all(sessionId) as {
      id: string;
      seq: number;
      type: string;
      at: string;
      manual: number | null;
      beforeTokens: number | null;
      afterTokens: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type as ContextEventType,
      at: r.at,
      manual: r.manual === 1,
      beforeTokens: r.beforeTokens,
      afterTokens: r.afterTokens,
    }));
  } catch {
    return [];
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

/** One event, by id — asked of the database rather than of a list of all of
 * them, which is what this was doing. */
export function getContextEvent(
  sessionId: string,
  eventId: string,
): ContextEvent | null {
  try {
    const r = db()
      .prepare(
        "SELECT id, session_id, seq, type, at, payload FROM context_events WHERE session_id = ? AND id = ?",
      )
      .get(sessionId, eventId) as
      | {
          id: string;
          session_id: string;
          seq: number;
          type: string;
          at: string;
          payload: string;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as ContextEventType,
      at: r.at,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
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

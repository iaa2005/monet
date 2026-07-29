/**
 * Durable log of tool executions — what the Background tasks panel shows.
 *
 * Written in the MAIN process, off the same events the renderer sees, for two
 * reasons. It is the authoritative source: a tool call happens here whether or
 * not a window is listening. And it survives a renderer reload, which an
 * in-memory registry in the store does not — the agent keeps running across
 * one, so a renderer-owned log would lose exactly the executions you most want
 * to look up afterwards.
 *
 * Cost is one INSERT per tool call and one UPDATE per result, against a tool
 * call that is already spawning a process or crossing the network. I argued
 * against persisting this when the panel was first built; that reasoning was
 * about writing the whole transcript twice, and it does not hold for two small
 * statements per call.
 *
 * Rows are pruned by count, oldest first — this is an activity history, not an
 * audit trail, and the transcript keeps the record that matters.
 */

import { getSessionDb } from "./session-store.js";
import { taskDetail, taskTitle } from "@shared/task-title";

/** Kept a few multiples above what the panel shows, so scrolling back stays
 * possible without the table growing without bound. */
export const MAX_ROWS = 2_000;

export type TaskStatus = "running" | "done" | "error";

export interface TaskRow {
  id: string;
  sessionId: string;
  tool: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
}

/** Output is kept for reading back, not for replay — a 5 MB build log in the
 * panel helps nobody and would bloat the DB. The tail is the useful half. */
const OUTPUT_KEEP = 4_000;

function clip(s: string): string {
  return s.length > OUTPUT_KEEP ? s.slice(-OUTPUT_KEEP) : s;
}

let ready = false;

function db(): ReturnType<typeof getSessionDb> {
  const d = getSessionDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS task_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        output TEXT
      );
      CREATE INDEX IF NOT EXISTS task_log_started ON task_log (started_at DESC);
    `);
    ready = true;
  }
  return d;
}

/** A tool call began. Ignores a repeat of the same id — a re-emitted event must
 * not open a second row for one call. Names it with the shared rule, so a row
 * reads the same live and after a restart. */
export function recordStart(row: {
  id: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}): void {
  const title = taskTitle(row.tool, row.input);
  const detail = taskDetail(row.tool, row.input);
  try {
    db()
      .prepare(
        `INSERT OR IGNORE INTO task_log
           (id, session_id, tool, title, detail, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        row.id,
        row.sessionId,
        row.tool,
        title,
        detail ?? null,
        Date.now(),
      );
    prune();
  } catch {
    /* the log is never allowed to break a run */
  }
}

/** Its result came back. Only closes a row that is still running, so a late
 * duplicate cannot overwrite the real result. */
export function recordFinish(
  id: string,
  output: string,
  isError: boolean,
): void {
  try {
    db()
      .prepare(
        `UPDATE task_log SET status = ?, finished_at = ?, output = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(isError ? "error" : "done", Date.now(), clip(output), id);
  } catch {
    /* ignore */
  }
}

/**
 * A run ended. Anything still running never reported back — Stop was pressed,
 * or the turn failed between the call and its result.
 *
 * Marked failed rather than done: left running they spin forever in the panel,
 * and marked done they claim a result that never arrived.
 */
export function settleSession(sessionId: string): void {
  try {
    db()
      .prepare(
        `UPDATE task_log SET status = 'error', finished_at = ?
         WHERE session_id = ? AND status = 'running'`,
      )
      .run(Date.now(), sessionId);
  } catch {
    /* ignore */
  }
}

/**
 * Anything left running from a previous process never will finish — the app
 * was killed mid-call. Called once at startup so the panel doesn't come back
 * showing ghosts spinning from last week.
 */
export function settleOrphans(): number {
  try {
    const r = db()
      .prepare(
        `UPDATE task_log SET status = 'error', finished_at = COALESCE(finished_at, ?)
         WHERE status = 'running'`,
      )
      .run(Date.now());
    return r.changes;
  } catch {
    return 0;
  }
}

export function listTasks(limit = 500): TaskRow[] {
  try {
    const rows = db()
      .prepare(
        `SELECT * FROM task_log ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      session_id: string;
      tool: string;
      title: string;
      detail: string | null;
      status: string;
      started_at: number;
      finished_at: number | null;
      output: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      tool: r.tool,
      title: r.title,
      detail: r.detail ?? undefined,
      status: r.status as TaskStatus,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      output: r.output ?? undefined,
    }));
  } catch {
    return [];
  }
}

/** Clear the finished rows. Running ones stay — their result is still coming,
 * and deleting the row would strand it. */
export function clearFinished(): void {
  try {
    db().prepare("DELETE FROM task_log WHERE status != 'running'").run();
  } catch {
    /* ignore */
  }
}

function prune(): void {
  try {
    db()
      .prepare(
        `DELETE FROM task_log WHERE status != 'running' AND id NOT IN (
           SELECT id FROM task_log ORDER BY started_at DESC LIMIT ?
         )`,
      )
      .run(MAX_ROWS);
  } catch {
    /* ignore */
  }
}

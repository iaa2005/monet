/**
 * Routines store — templated agent tasks kicked off on a schedule (cron),
 * manually, by webhook, or by a connector event. A routine is an IFTTT-style
 * automation whose "action" is a full agent run (the prompt), optionally gated
 * by a condition. Runs are recorded so the UI can show history.
 *
 * Persisted in the shared sessions.db (routines + routine_runs tables).
 */

import { randomUUID } from "node:crypto";
import { getSessionDb } from "../session/store.js";

export type TriggerKind = "schedule" | "manual" | "webhook" | "event";

export interface RoutineTrigger {
  kind: TriggerKind;
  /** schedule: 5-field cron (local time). */
  cron?: string;
  /** webhook: opaque id embedded in the inbound URL. */
  webhookId?: string;
  /** event: which connector + event type, polled every intervalMinutes, with an
   * optional filter description. */
  event?: {
    connector: string;
    type: string;
    intervalMinutes?: number;
    filter?: string;
  };
}

export interface RoutineCondition {
  /** "always" runs unconditionally; "agent" asks the model a yes/no gate first. */
  kind: "always" | "agent";
  /** agent gate: a question answered yes → run, no → skip. */
  prompt?: string;
}

export type OutputKind = "chat" | "notification" | "connector";

export interface Routine {
  id: string;
  name: string;
  /** The instruction the agent runs each time. */
  prompt: string;
  space: "home" | "code";
  /** Connector ids whose tools the routine may use (empty = default toolset). */
  connectors: string[];
  /** Connector action ids granted for UNATTENDED use ("chat.send"). Without a
   * grant, ask-level actions are denied when nobody is watching; destructive
   * actions are never grantable at all (the engine enforces both). */
  grants?: string[];
  /** Long-term memory in the run's system prompt (default true). Off = the
   * routine works from its instructions alone. */
  memory?: boolean;
  /** Pin this routine to a provider+model. Empty = whatever is active when it
   * fires — which is what most routines want, but a nightly digest may want a
   * cheap or local model regardless of what the user is chatting with. */
  providerId?: string;
  model?: string;
  trigger: RoutineTrigger;
  condition?: RoutineCondition;
  output: { kind: OutputKind; connector?: string };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun?: string;
  nextRun?: string;
  lastStatus?: "ok" | "error" | "skipped" | "running";
}

export interface RoutineRun {
  id: string;
  routineId: string;
  at: string;
  status: "ok" | "error" | "skipped" | "running";
  /** The chat this run produced (output.kind === "chat"). */
  sessionId?: string;
  summary?: string;
  error?: string;
}

let ready = false;
function db(): ReturnType<typeof getSessionDb> {
  const d = getSessionDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        space TEXT NOT NULL DEFAULT 'code',
        connectors TEXT NOT NULL DEFAULT '[]',
        trigger TEXT NOT NULL,
        condition TEXT,
        output TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run TEXT,
        next_run TEXT,
        last_status TEXT
      );
      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        summary TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_routine ON routine_runs(routine_id);
    `);
    // Unattended action grants (phase-4 column; older DBs lack it).
    try {
      d.exec(`ALTER TABLE routines ADD COLUMN grants TEXT`);
    } catch {
      /* column already exists */
    }
    // Per-routine model pin. Separate try blocks: the second ALTER must still
    // run on a DB that already has the first column.
    try {
      d.exec(`ALTER TABLE routines ADD COLUMN provider_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      d.exec(`ALTER TABLE routines ADD COLUMN model TEXT`);
    } catch {
      /* column already exists */
    }
    // Per-routine memory switch. NULL (older rows) reads as ON.
    try {
      d.exec(`ALTER TABLE routines ADD COLUMN memory INTEGER`);
    } catch {
      /* column already exists */
    }
    // Backfill chats that predate sessions.routine_id, from the run history —
    // done here because routine_runs is guaranteed to exist by this point.
    // Chats whose routine was already deleted are unrecoverable: their runs went
    // with it. That's the bug this column exists to stop repeating.
    try {
      d.exec(`
        UPDATE sessions SET routine_id = (
          SELECT rr.routine_id FROM routine_runs rr
          WHERE rr.session_id = sessions.id LIMIT 1
        )
        WHERE routine_id IS NULL
          AND id IN (SELECT session_id FROM routine_runs WHERE session_id IS NOT NULL)
      `);
    } catch {
      /* best-effort: a failed backfill must not break routines */
    }
    ready = true;
  }
  return d;
}

interface Row {
  id: string;
  name: string;
  prompt: string;
  space: string;
  connectors: string;
  grants: string | null;
  provider_id: string | null;
  model: string | null;
  memory: number | null;
  trigger: string;
  condition: string | null;
  output: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_run: string | null;
  next_run: string | null;
  last_status: string | null;
}

function rowToRoutine(r: Row): Routine {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    space: (r.space as Routine["space"]) || "code",
    connectors: JSON.parse(r.connectors || "[]") as string[],
    grants: r.grants ? (JSON.parse(r.grants) as string[]) : undefined,
    providerId: r.provider_id ?? undefined,
    model: r.model ?? undefined,
    memory: r.memory === 0 ? false : true,
    trigger: JSON.parse(r.trigger) as RoutineTrigger,
    condition: r.condition ? (JSON.parse(r.condition) as RoutineCondition) : undefined,
    output: JSON.parse(r.output) as Routine["output"],
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRun: r.last_run ?? undefined,
    nextRun: r.next_run ?? undefined,
    lastStatus: (r.last_status as Routine["lastStatus"]) ?? undefined,
  };
}

export function listRoutines(): Routine[] {
  return (
    db()
      .prepare("SELECT * FROM routines ORDER BY created_at DESC")
      .all() as Row[]
  ).map(rowToRoutine);
}

export function getRoutine(id: string): Routine | null {
  const r = db().prepare("SELECT * FROM routines WHERE id = ?").get(id) as
    | Row
    | undefined;
  return r ? rowToRoutine(r) : null;
}

export type RoutineInput = Omit<
  Routine,
  "id" | "createdAt" | "updatedAt" | "lastRun" | "nextRun" | "lastStatus"
>;

export function createRoutine(input: RoutineInput): Routine {
  const now = new Date().toISOString();
  const r: Routine = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
  db()
    .prepare(
      `INSERT INTO routines (id, name, prompt, space, connectors, grants, provider_id, model, memory, trigger, condition, output, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.name,
      r.prompt,
      r.space,
      JSON.stringify(r.connectors),
      r.grants?.length ? JSON.stringify(r.grants) : null,
      r.providerId || null,
      r.model || null,
      r.memory === false ? 0 : 1,
      JSON.stringify(r.trigger),
      r.condition ? JSON.stringify(r.condition) : null,
      JSON.stringify(r.output),
      r.enabled ? 1 : 0,
      r.createdAt,
      r.updatedAt,
    );
  return r;
}

export function updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
  const cur = getRoutine(id);
  if (!cur) return null;
  const next: Routine = { ...cur, ...patch, id, updatedAt: new Date().toISOString() };
  db()
    .prepare(
      `UPDATE routines SET name=?, prompt=?, space=?, connectors=?, grants=?, provider_id=?, model=?, memory=?, trigger=?, condition=?, output=?, enabled=?, updated_at=?, last_run=?, next_run=?, last_status=? WHERE id=?`,
    )
    .run(
      next.name,
      next.prompt,
      next.space,
      JSON.stringify(next.connectors),
      next.grants?.length ? JSON.stringify(next.grants) : null,
      next.providerId || null,
      next.model || null,
      next.memory === false ? 0 : 1,
      JSON.stringify(next.trigger),
      next.condition ? JSON.stringify(next.condition) : null,
      JSON.stringify(next.output),
      next.enabled ? 1 : 0,
      next.updatedAt,
      next.lastRun ?? null,
      next.nextRun ?? null,
      next.lastStatus ?? null,
      id,
    );
  return next;
}

export function deleteRoutine(id: string): boolean {
  const d = db();
  d.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
  return d.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
}

// ─── Runs ────────────────────────────────────────────────────────────────

export function recordRun(run: RoutineRun): void {
  db()
    .prepare(
      "INSERT INTO routine_runs (id, routine_id, at, status, session_id, summary, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      run.id,
      run.routineId,
      run.at,
      run.status,
      run.sessionId ?? null,
      run.summary ?? null,
      run.error ?? null,
    );
}

/** Chats produced by routine runs (newest run per chat), for the sidebar's
 * "Routines" section — joined to the sessions table (same DB). */
/**
 * Chats produced by routines.
 *
 * Reads the chat's own routine_id, NOT the run history: runs are deleted with
 * their routine, so deriving it from them meant deleting a routine silently
 * reclassified its past chats as ordinary Recents. A chat a routine wrote stays
 * a chat a routine wrote.
 */
export function listRoutineChats(
  limit = 50,
  space?: string,
): { id: string; title: string; at: string; routineId: string; routineName: string }[] {
  try {
    let query =
      `SELECT s.id AS id, s.title AS title, s.updated_at AS at,
              s.routine_id AS routineId, r.name AS routineName
       FROM sessions s
       LEFT JOIN routines r ON r.id = s.routine_id
       WHERE s.routine_id IS NOT NULL AND s.archived = 0`;
    const params: (string | number)[] = [];
    if (space) {
      query += " AND s.space = ?";
      params.push(space);
    }
    query += " ORDER BY s.updated_at DESC LIMIT ?";
    params.push(limit);
    return db()
      .prepare(query)
      .all(...params) as { id: string; title: string; at: string; routineId: string; routineName: string }[];
  } catch {
    return [];
  }
}

export function listRuns(routineId: string, limit = 20): RoutineRun[] {
  const rows = db()
    .prepare(
      "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY at DESC LIMIT ?",
    )
    .all(routineId, limit) as {
    id: string;
    routine_id: string;
    at: string;
    status: string;
    session_id: string | null;
    summary: string | null;
    error: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    routineId: r.routine_id,
    at: r.at,
    status: r.status as RoutineRun["status"],
    sessionId: r.session_id ?? undefined,
    summary: r.summary ?? undefined,
    error: r.error ?? undefined,
  }));
}

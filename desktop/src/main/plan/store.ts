/**
 * The plan as a DOCUMENT, not a dialog.
 *
 * ExitPlanMode used to flash the plan in an approval prompt and throw it
 * away: nothing recorded what was approved, nothing tracked what got done.
 * This store makes the plan a first-class per-session document — markdown
 * body, a todo list with live statuses, and a comment thread where the user
 * and every agent (main or sub, each under its own name) can say what they
 * did, what they skipped, and why.
 *
 * Lifecycle: draft (being written / sent back for revision) → ready (handed
 * over, awaiting Build) → building (approved, agents work through it and
 * check items off) → done. One plan is "current" per session — the latest —
 * but earlier plans stay readable, like .plan.md files piling up in Cursor.
 *
 * Storage is a row per plan in the session DB with a JSON doc column: the
 * document changes as one thing (a todo flip bumps updatedAt and re-renders
 * everywhere), and main is the only writer.
 */

import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { getSessionDb } from "../session-store.js";
import type {
  Plan,
  PlanComment,
  PlanStatus,
  PlanTodoStatus,
} from "@shared/plan.js";

export type { Plan, PlanComment, PlanStatus, PlanTodo, PlanTodoStatus } from "@shared/plan.js";

let ready = false;
function db(): ReturnType<typeof getSessionDb> {
  const d = getSessionDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        doc TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
    `);
    ready = true;
  }
  return d;
}

function broadcast(sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("plan:changed", sessionId);
}

function rowToPlan(row: { doc: string }): Plan | null {
  try {
    return JSON.parse(row.doc) as Plan;
  } catch {
    return null;
  }
}

function write(plan: Plan): void {
  plan.updatedAt = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO plans (id, session_id, doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
    )
    .run(plan.id, plan.sessionId, JSON.stringify(plan), plan.createdAt, plan.updatedAt);
  broadcast(plan.sessionId);
}

export function getPlan(planId: string): Plan | null {
  try {
    const row = db()
      .prepare("SELECT doc FROM plans WHERE id = ?")
      .get(planId) as { doc: string } | undefined;
    return row ? rowToPlan(row) : null;
  } catch {
    return null;
  }
}

/** The session's current plan — the latest one, whatever its status. */
export function currentPlan(sessionId: string): Plan | null {
  try {
    const row = db()
      .prepare(
        "SELECT doc FROM plans WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(sessionId) as { doc: string } | undefined;
    return row ? rowToPlan(row) : null;
  } catch {
    return null;
  }
}

export function listPlans(sessionId: string): Plan[] {
  try {
    const rows = db()
      .prepare(
        "SELECT doc FROM plans WHERE session_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(sessionId) as { doc: string }[];
    return rows.map(rowToPlan).filter((p): p is Plan => p !== null);
  } catch {
    return [];
  }
}

export function createPlan(
  sessionId: string,
  input: { title: string; summary?: string; body: string; todos: string[] },
): Plan {
  const now = new Date().toISOString();
  const plan: Plan = {
    id: randomUUID(),
    sessionId,
    title: input.title,
    summary: input.summary,
    body: input.body,
    status: "ready",
    todos: input.todos.map((text) => ({
      id: randomUUID(),
      text,
      status: "pending",
    })),
    comments: [],
    agents: [],
    createdAt: now,
    updatedAt: now,
  };
  write(plan);
  return plan;
}

/**
 * A revision replaces the CONTENT of the current draft/ready plan instead of
 * minting a new document — "keep planning" iterates on one plan, it does not
 * litter the session with near-copies. Completed states are shut: a plan the
 * user built from (or archived as done) is a record, so revising after that
 * starts a fresh document.
 */
export function revisePlan(
  sessionId: string,
  input: { title: string; summary?: string; body: string; todos: string[] },
): Plan {
  const cur = currentPlan(sessionId);
  if (!cur || (cur.status !== "draft" && cur.status !== "ready"))
    return createPlan(sessionId, input);
  // Keep statuses of todos whose text survived the revision — re-planning
  // mid-build must not uncheck finished work.
  const oldByText = new Map(cur.todos.map((t) => [t.text, t]));
  const next: Plan = {
    ...cur,
    title: input.title,
    summary: input.summary,
    body: input.body,
    status: "ready",
    todos: input.todos.map(
      (text) =>
        oldByText.get(text) ?? { id: randomUUID(), text, status: "pending" },
    ),
  };
  write(next);
  return next;
}

export function setPlanStatus(planId: string, status: PlanStatus): Plan | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  plan.status = status;
  write(plan);
  return plan;
}

export function setTodoStatus(
  planId: string,
  todoId: string,
  status: PlanTodoStatus,
  by: string,
  note?: string,
): Plan | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  const todo = plan.todos.find((t) => t.id === todoId);
  if (!todo) return null;
  todo.status = status;
  todo.by = by;
  if (note !== undefined) todo.note = note;
  if (by !== "user" && !plan.agents.includes(by)) plan.agents.push(by);
  // The last box ticked closes the plan; nobody remembers to call "done".
  if (
    plan.status === "building" &&
    plan.todos.every((t) => t.status === "completed" || t.status === "skipped")
  )
    plan.status = "done";
  write(plan);
  return plan;
}

export function addComment(
  planId: string,
  comment: { author: string; kind: "user" | "agent"; text: string; todoId?: string },
): Plan | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  plan.comments.push({
    id: randomUUID(),
    author: comment.author,
    kind: comment.kind,
    text: comment.text,
    todoId: comment.todoId,
    at: new Date().toISOString(),
    // Agent remarks are FOR the user; user remarks wait for the next turn.
    seenByAgent: comment.kind === "agent",
  });
  if (comment.kind === "agent" && !plan.agents.includes(comment.author))
    plan.agents.push(comment.author);
  write(plan);
  return plan;
}

/** User comments the model has not been shown yet (see plan/inject.ts). */
export function unseenComments(plan: Plan): PlanComment[] {
  return plan.comments.filter((c) => c.kind === "user" && !c.seenByAgent);
}

export function markCommentsSeen(planId: string, ids: string[]): void {
  const plan = getPlan(planId);
  if (!plan || ids.length === 0) return;
  const set = new Set(ids);
  for (const c of plan.comments) if (set.has(c.id)) c.seenByAgent = true;
  write(plan);
}

/**
 * The document as a .plan.md — what Export writes and what the viewer shows.
 * Checkbox state mirrors todo status; per-item notes ride as blockquotes.
 */
export function planToMarkdown(plan: Plan): string {
  const lines: string[] = [`# ${plan.title}`, ""];
  if (plan.summary) lines.push(plan.summary, "");
  if (plan.body.trim()) lines.push(plan.body.trim(), "");
  if (plan.todos.length) {
    lines.push("## Todos", "");
    for (const t of plan.todos) {
      const mark =
        t.status === "completed" ? "x" : t.status === "skipped" ? "-" : " ";
      lines.push(`- [${mark}] ${t.text}`);
      if (t.note) lines.push(`  > ${t.note}${t.by ? ` — ${t.by}` : ""}`);
    }
    lines.push("");
  }
  const remarks = plan.comments.filter((c) => !c.todoId);
  if (remarks.length) {
    lines.push("## Comments", "");
    for (const c of remarks) lines.push(`- **${c.author}**: ${c.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Session deletion: a chat's plans go with it. */
export function deletePlans(sessionId: string): void {
  try {
    db().prepare("DELETE FROM plans WHERE session_id = ?").run(sessionId);
    broadcast(sessionId);
  } catch {
    /* nothing to delete */
  }
}

/** Import path (transfer bundle): store a plan verbatim under new ids. */
export function importPlan(plan: Plan, sessionId: string): Plan {
  const todoIdMap = new Map(plan.todos.map((t) => [t.id, randomUUID()]));
  const copy: Plan = {
    ...plan,
    id: randomUUID(),
    sessionId,
    todos: plan.todos.map((t) => ({ ...t, id: todoIdMap.get(t.id) ?? t.id })),
    // A comment pinned to a todo must follow it onto its new id.
    comments: plan.comments.map((c) => ({
      ...c,
      id: randomUUID(),
      todoId: c.todoId ? todoIdMap.get(c.todoId) : undefined,
    })),
  };
  write(copy);
  return copy;
}

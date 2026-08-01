/**
 * In-memory plan store for the smoke harness.
 *
 * The real plan/store.ts persists through better-sqlite3, whose native binary
 * is built for Electron's ABI — under the smoke harness's plain Node it does
 * not load. Smoke exercises the APPROVAL CONTRACT (the plan reaches the user,
 * feedback comes back, approval unblocks the turn), not persistence; the real
 * store's lifecycle rules are probed under Electron by scripts/plan-probe.cjs.
 * Aliased in scripts/smoke-agent.mjs.
 */
import { randomUUID } from "node:crypto";
import type { Plan, PlanComment, PlanStatus, PlanTodoStatus } from "../src/shared/plan.js";

export type { Plan, PlanComment, PlanStatus, PlanTodoStatus };

const plans = new Map<string, Plan>(); // planId → plan

const bySession = (sessionId: string): Plan[] =>
  [...plans.values()].filter((p) => p.sessionId === sessionId);

export function getPlan(planId: string): Plan | null {
  return plans.get(planId) ?? null;
}

export function currentPlan(sessionId: string): Plan | null {
  const all = bySession(sessionId);
  return all.length ? all[all.length - 1] : null;
}

export function listPlans(sessionId: string): Plan[] {
  return bySession(sessionId);
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
    todos: input.todos.map((text) => ({ id: randomUUID(), text, status: "pending" })),
    comments: [],
    agents: [],
    createdAt: now,
    updatedAt: now,
  };
  plans.set(plan.id, plan);
  return plan;
}

export function revisePlan(
  sessionId: string,
  input: { title: string; summary?: string; body: string; todos: string[] },
): Plan {
  const cur = currentPlan(sessionId);
  if (!cur || (cur.status !== "draft" && cur.status !== "ready"))
    return createPlan(sessionId, input);
  cur.title = input.title;
  cur.summary = input.summary;
  cur.body = input.body;
  cur.status = "ready";
  cur.todos = input.todos.map((text) => ({ id: randomUUID(), text, status: "pending" }));
  return cur;
}

export function setPlanStatus(planId: string, status: PlanStatus): Plan | null {
  const p = plans.get(planId);
  if (p) p.status = status;
  return p ?? null;
}

export function setTodoStatus(
  planId: string,
  todoId: string,
  status: PlanTodoStatus,
  by: string,
  note?: string,
): Plan | null {
  const p = plans.get(planId);
  const t = p?.todos.find((t) => t.id === todoId);
  if (!p || !t) return null;
  t.status = status;
  t.by = by;
  if (note !== undefined) t.note = note;
  return p;
}

export function addComment(
  planId: string,
  comment: { author: string; kind: "user" | "agent"; text: string; todoId?: string },
): Plan | null {
  const p = plans.get(planId);
  if (!p) return null;
  p.comments.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    seenByAgent: comment.kind === "agent",
    ...comment,
  });
  return p;
}

export function unseenComments(plan: Plan): PlanComment[] {
  return plan.comments.filter((c) => c.kind === "user" && !c.seenByAgent);
}

export function markCommentsSeen(planId: string, ids: string[]): void {
  const p = plans.get(planId);
  if (!p) return;
  for (const c of p.comments) if (ids.includes(c.id)) c.seenByAgent = true;
}

export function deletePlans(sessionId: string): void {
  for (const p of bySession(sessionId)) plans.delete(p.id);
}

export function planToMarkdown(plan: Plan): string {
  return `# ${plan.title}\n`;
}

export function importPlan(plan: Plan, sessionId: string): Plan {
  const copy = { ...plan, id: randomUUID(), sessionId };
  plans.set(copy.id, copy);
  return copy;
}

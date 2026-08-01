/**
 * The plan document's shape — shared between main (plan/store.ts, the only
 * writer) and the renderer (chat card, dock panel), like selection-tones.
 */

export type PlanStatus = "draft" | "ready" | "building" | "done";
export type PlanTodoStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface PlanTodo {
  id: string;
  text: string;
  status: PlanTodoStatus;
  /** Who moved it last — "user" or an agent's display name. */
  by?: string;
  /** A short remark attached to the item ("tests were already green"). */
  note?: string;
}

export interface PlanComment {
  id: string;
  /** "user", or the agent's display name ("Explore", "Reviewer", …). */
  author: string;
  kind: "user" | "agent";
  text: string;
  at: string;
  /** Set when the remark is about one todo rather than the whole plan. */
  todoId?: string;
  /** User comments start unseen; the next turn injects and marks them. */
  seenByAgent?: boolean;
}

export interface Plan {
  id: string;
  sessionId: string;
  title: string;
  /** One-sentence summary shown on the chat card under the title. */
  summary?: string;
  /** The detailed plan, markdown. */
  body: string;
  status: PlanStatus;
  todos: PlanTodo[];
  comments: PlanComment[];
  /** Agents that have touched the document — "Referenced by N agents". */
  agents: string[];
  createdAt: string;
  updatedAt: string;
}

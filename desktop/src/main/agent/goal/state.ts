/**
 * Goal state — what an autonomous objective is, and how it may change.
 *
 * A goal says what must become TRUE, where an ordinary prompt says what to do
 * next. The runtime then keeps taking turns until the objective is met, the
 * budget runs out, or the model reports it is stuck.
 *
 * Four states, one of them transient:
 *
 *   active   — the driver is running turns. The only state that continues.
 *   paused   — kept, not pursued. From the user, an interrupt, a resumed
 *              session, or a provider error.
 *   blocked  — the model says it cannot get further as stated, or a budget
 *              ran out. Kept, and resumable after the user changes something.
 *   complete — momentary: the record is cleared as soon as it is reported.
 *
 * There is deliberately no `cancelled`. Cancelling is deleting; a tombstone
 * state would only be one more thing for the model to reason about.
 *
 * Pure: no clock beyond what is passed in, no disk, no model. The transitions
 * are the part where an off-by-one silently produces a runaway loop, so they
 * are testable on their own.
 */

export type GoalStatus = "active" | "paused" | "blocked";

/** Why a goal stopped advancing — shown to the user, and to the model. */
export type GoalStopReason =
  | "user"
  | "interrupted"
  | "session-resumed"
  | "provider-error"
  | "model-blocked"
  | "turn-budget"
  | "token-budget"
  | "connector-refused";

export interface GoalBudget {
  /**
   * Hardest limit, and the one that actually stops a runaway.
   *
   * Kimi Code leaves this open and trusts the model to signal completion; that
   * is fine for a terminal a person is watching, and not for an app that can
   * send mail. A goal that has taken 25 turns without finishing has almost
   * certainly misunderstood something, and stopping to say so is better than
   * turn 26.
   */
  maxTurns: number;
  /** Optional spend ceiling, counted across the goal's turns. */
  maxTokens?: number;
}

export interface GoalStats {
  turns: number;
  tokens: number;
  startedAt: string;
}

export interface Goal {
  id: string;
  objective: string;
  /** How the model will know it is done, when the user stated one. */
  completionCriterion?: string;
  status: GoalStatus;
  /** Set when status is paused or blocked. */
  stopReason?: GoalStopReason;
  /** Free text explaining the stop, from whoever stopped it. */
  stopDetail?: string;
  /**
   * Connector action ids this goal may use WITHOUT asking, chosen by the user
   * when the goal started.
   *
   * A goal is meant to run without supervision; a connector action leaves the
   * machine — mail, chat, anything published. Those two facts together are why
   * this list is explicit rather than inherited from the session's permission
   * mode. Anything not listed still reaches the user as a question.
   */
  connectorGrants: string[];
  budget: GoalBudget;
  stats: GoalStats;
  updatedAt: string;
}

export const DEFAULT_MAX_TURNS = 25;

/** Longest an objective may be — a prompt, not a document. */
export const MAX_OBJECTIVE_CHARS = 4_000;

export interface CreateGoalInput {
  objective: string;
  completionCriterion?: string;
  connectorGrants?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

export type CreateResult =
  | { ok: true; goal: Goal }
  | { ok: false; error: string };

/**
 * Make a goal, or explain why not.
 *
 * Refuses to overwrite an existing goal. Silently replacing one would lose
 * work the user is waiting on, and "replace" is a thing they can ask for
 * explicitly.
 */
export function createGoal(
  existing: Goal | null,
  input: CreateGoalInput,
  now: Date,
  id: string,
): CreateResult {
  const objective = input.objective.trim();
  if (!objective) return { ok: false, error: "A goal needs an objective." };
  if (objective.length > MAX_OBJECTIVE_CHARS)
    return {
      ok: false,
      error: `The objective is ${objective.length} characters, over the ${MAX_OBJECTIVE_CHARS} limit. State the outcome, not the whole plan.`,
    };
  if (existing)
    return {
      ok: false,
      error: `A goal is already ${existing.status} ("${truncate(existing.objective, 60)}"). Replace or cancel it first.`,
    };

  const maxTurns =
    Number.isInteger(input.maxTurns) && (input.maxTurns as number) > 0
      ? Math.min(input.maxTurns as number, 200)
      : DEFAULT_MAX_TURNS;

  return {
    ok: true,
    goal: {
      id,
      objective,
      completionCriterion: input.completionCriterion?.trim() || undefined,
      status: "active",
      connectorGrants: [...(input.connectorGrants ?? [])],
      budget: {
        maxTurns,
        maxTokens:
          Number.isFinite(input.maxTokens) && (input.maxTokens as number) > 0
            ? (input.maxTokens as number)
            : undefined,
      },
      stats: { turns: 0, tokens: 0, startedAt: now.toISOString() },
      updatedAt: now.toISOString(),
    },
  };
}

function stamp(goal: Goal, now: Date, patch: Partial<Goal>): Goal {
  return { ...goal, ...patch, updatedAt: now.toISOString() };
}

export function pauseGoal(
  goal: Goal,
  now: Date,
  reason: GoalStopReason = "user",
  detail?: string,
): Goal {
  return stamp(goal, now, { status: "paused", stopReason: reason, stopDetail: detail });
}

export function blockGoal(
  goal: Goal,
  now: Date,
  reason: GoalStopReason,
  detail?: string,
): Goal {
  return stamp(goal, now, { status: "blocked", stopReason: reason, stopDetail: detail });
}

/**
 * Resume a paused or blocked goal.
 *
 * Resuming resets nothing but the status: the turn count carries over, so a
 * goal that hit its budget and was resumed without raising the budget stops
 * again immediately. That is the honest behaviour — the alternative quietly
 * doubles the ceiling every time someone clicks resume.
 */
export function resumeGoal(goal: Goal, now: Date): Goal {
  return stamp(goal, now, {
    status: "active",
    stopReason: undefined,
    stopDetail: undefined,
  });
}

/** Record a completed turn against the budget. */
export function countTurn(goal: Goal, now: Date, tokensUsed: number): Goal {
  return stamp(goal, now, {
    stats: {
      ...goal.stats,
      turns: goal.stats.turns + 1,
      tokens: goal.stats.tokens + Math.max(0, tokensUsed),
    },
  });
}

export type ContinueDecision =
  | { continue: true }
  | { continue: false; reason: GoalStopReason; detail: string };

/**
 * Whether the driver may take another turn.
 *
 * Checked AFTER a turn is counted, so the limits mean "at most this many
 * turns", not "this many plus one".
 */
export function shouldContinue(goal: Goal): ContinueDecision {
  if (goal.status !== "active")
    return {
      continue: false,
      reason: goal.stopReason ?? "user",
      detail: `The goal is ${goal.status}.`,
    };
  if (goal.stats.turns >= goal.budget.maxTurns)
    return {
      continue: false,
      reason: "turn-budget",
      detail: `Stopped after ${goal.stats.turns} turns (the limit). The objective was not reported complete — say what is left.`,
    };
  if (goal.budget.maxTokens && goal.stats.tokens >= goal.budget.maxTokens)
    return {
      continue: false,
      reason: "token-budget",
      detail: `Stopped after ${goal.stats.tokens} tokens (the limit). The objective was not reported complete — say what is left.`,
    };
  return { continue: true };
}

/** One-line status for the UI strip. */
export function describeGoal(goal: Goal): string {
  const parts = [`${goal.status}`, `turn ${goal.stats.turns}/${goal.budget.maxTurns}`];
  if (goal.budget.maxTokens)
    parts.push(`${goal.stats.tokens}/${goal.budget.maxTokens} tokens`);
  return parts.join(" · ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

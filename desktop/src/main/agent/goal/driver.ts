/**
 * The goal driver — what turns one prompt into autonomous work.
 *
 * After a turn ends, if the session's goal is still `active`, it starts
 * another with a continuation prompt. That loop is the whole feature, and it
 * is also the whole risk, so every exit is explicit:
 *
 *   - the model called UpdateGoal (complete clears the goal; blocked stops it)
 *   - the turn budget or token budget ran out
 *   - the run was aborted (the user pressed stop, or sent a new message)
 *   - a turn threw
 *
 * Nothing here decides to keep going by default: `shouldContinue` has to say
 * yes, and it only says yes while the record is `active`.
 */

import type { LLMEvent } from "../../llm/adapter.js";
import {
  countTurn,
  pauseGoal,
  shouldContinue,
  blockGoal,
  type Goal,
  type GoalStopReason,
} from "./state.js";
import { continuationPrompt } from "./inject.js";
import { loadGoal, saveGoal } from "./store.js";

export interface GoalTurnRunner {
  /** Run ONE ordinary turn with this prompt. Resolves when it ends. */
  (prompt: string): Promise<void>;
}

export interface DriveOptions {
  sessionId: string;
  /** Tokens the turn just consumed, for the budget. */
  tokensForLastTurn: () => number;
  isAborted: () => boolean;
  /** Told about each state change, so the UI strip can follow along. */
  onGoalEvent?: (event: LLMEvent) => void;
}

/**
 * Keep taking turns while the goal is active.
 *
 * Called after the FIRST turn of a goal has already run, so it counts that
 * turn before deciding anything — a `maxTurns: 1` goal must take exactly one
 * turn, not two.
 */
export async function driveGoal(
  runTurn: GoalTurnRunner,
  opts: DriveOptions,
): Promise<void> {
  const { sessionId } = opts;

  for (;;) {
    let goal = loadGoal(sessionId);
    // Cleared by UpdateGoal(complete), or cancelled from the UI mid-turn.
    if (!goal) return;

    goal = countTurn(goal, new Date(), opts.tokensForLastTurn());
    saveGoal(sessionId, goal);
    emitGoal(opts, goal);

    if (opts.isAborted()) {
      stop(opts, goal, "interrupted", "The run was interrupted.");
      return;
    }

    const verdict = shouldContinue(goal);
    if (!verdict.continue) {
      // A goal that ran out of budget is BLOCKED, not paused: paused implies
      // the user chose to stop, and blocked is what needs their attention.
      if (verdict.reason === "turn-budget" || verdict.reason === "token-budget")
        stop(opts, goal, verdict.reason, verdict.detail, "blocked");
      else if (goal.status === "active")
        stop(opts, goal, verdict.reason, verdict.detail);
      return;
    }

    try {
      await runTurn(continuationPrompt());
    } catch (err) {
      // A provider or runtime failure PAUSES rather than blocks: nothing about
      // the objective is wrong, and the user can retry once the cause is gone.
      stop(
        opts,
        loadGoal(sessionId) ?? goal,
        "provider-error",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  }
}

function stop(
  opts: DriveOptions,
  goal: Goal,
  reason: GoalStopReason,
  detail: string,
  as: "paused" | "blocked" = "paused",
): void {
  const now = new Date();
  const next =
    as === "blocked"
      ? blockGoal(goal, now, reason, detail)
      : pauseGoal(goal, now, reason, detail);
  saveGoal(opts.sessionId, next);
  emitGoal(opts, next);

  // A budget stop is a retrospective too: the next goal in this workspace
  // should know this one ran out rather than rediscover it. Fire-and-forget —
  // the driver never waits on continuity bookkeeping.
  if (as === "blocked") {
    void (async () => {
      try {
        const { getSessionStore } = await import("../../session-store.js");
        const { getWorkspacePath } = await import("../../ipc/workspace.js");
        const { addGoalRunNote } = await import("../run-notes.js");
        const workspace =
          getSessionStore().get(opts.sessionId)?.workspace || getWorkspacePath();
        if (workspace)
          addGoalRunNote(workspace, {
            at: now.toISOString(),
            outcome: "blocked",
            reason,
            objective: goal.objective,
            note: detail,
            turns: goal.stats.turns,
          });
      } catch {
        /* continuity, not correctness */
      }
    })();
  }
}

function emitGoal(opts: DriveOptions, goal: Goal): void {
  opts.onGoalEvent?.({
    type: "goal",
    status: goal.status,
    objective: goal.objective,
    turns: goal.stats.turns,
    maxTurns: goal.budget.maxTurns,
    tokens: goal.stats.tokens,
    maxTokens: goal.budget.maxTokens,
    detail: goal.stopDetail,
  } as LLMEvent);
}

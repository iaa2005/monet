/**
 * What to do when the model answers with nothing at all.
 *
 * A reply with no text and no tool calls is not an answer — it is a model
 * that lost the thread, and the agent loop reads it as "done" because that is
 * what "no tool calls" means everywhere else. The run then ends mid-task in
 * total silence: nothing is written to the transcript (there is no content to
 * write), so the chat simply stops after the last tool card.
 *
 * The cure is the one people already use by hand: send a bare "." and the
 * model picks the thread back up. Doing it in the harness costs one turn and
 * saves the whole run, and it stays invisible — the user asked for a result,
 * not for a notice explaining that their model hiccuped.
 *
 * Bounded, because a nudge that does not take must not become a loop:
 *   - at most MAX_NUDGES per run, and
 *   - never twice in a row. An empty reply immediately after a nudge means
 *     the nudge did not work, and a second one would only spend money.
 *
 * Pure: no electron, no model, no disk — the decision is what a probe needs
 * to pin down, and the mutation is small enough to test in place.
 */

import type { LLMMessage } from "../llm/adapter.js";

/** What a user sends by hand to say "keep going". */
export const NUDGE = ".";

export const MAX_NUDGES = 2;

export interface EmptyTurnState {
  /** The turn produced no text and no tool calls. */
  emptyReply: boolean;
  nudgesUsed: number;
  /** The previous turn of this run was itself a nudge. */
  nudgedLastTurn: boolean;
  max?: number;
}

export function shouldNudge(state: EmptyTurnState): boolean {
  if (!state.emptyReply) return false;
  // Two empties in a row: the model is not stuck, it is finished or broken.
  if (state.nudgedLastTurn) return false;
  return state.nudgesUsed < (state.max ?? MAX_NUDGES);
}

/** Whether a turn's output counts as "nothing at all". */
export function isEmptyReply(text: string, toolCallCount: number): boolean {
  return toolCallCount === 0 && text.trim().length === 0;
}

export type NudgePlacement = "merged" | "pushed" | "none";

/**
 * Put a harness-written line where it will not break role alternation.
 *
 * The last message is a user one in every real case (the tool results of the
 * turn that came back empty, or — on an empty first reply — the user's own
 * prompt), and the providers this app speaks to are not all forgiving about
 * two user messages in a row. So the line JOINS that message instead of
 * becoming a second one: a text block beside the tool results, which is the
 * same shape mid-turn injections already use. A string body is widened to
 * blocks so the user's own words survive verbatim as their own block.
 *
 * Used by the empty-reply nudge and by the step-budget notes alike — what
 * differs between them is the words, not the placement.
 */
export function appendUserText(
  messages: LLMMessage[],
  nudge: string = NUDGE,
): NudgePlacement {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    // Not a shape the loop produces, but pushing beats losing the run.
    messages.push({ role: "user", content: nudge });
    return "pushed";
  }
  if (Array.isArray(last.content)) {
    last.content.push({ type: "text", text: nudge });
  } else {
    last.content = [
      { type: "text", text: last.content },
      { type: "text", text: nudge },
    ];
  }
  return "merged";
}

/**
 * What gets written down about how a turn ended.
 *
 * The provider's own word, plus the fact the reply was empty — which is the
 * distinction a post-mortem actually needs: "end_turn" with nothing in it is
 * a model that gave up, "max_tokens" with nothing in it is a reasoning budget
 * that ate the whole answer. Without this the two look identical: silence.
 */
export function stopReasonLabel(
  stopReason: string | undefined,
  empty: boolean,
): string {
  const base = stopReason && stopReason.trim() ? stopReason.trim() : "unknown";
  return empty ? `${base} (empty reply)` : base;
}

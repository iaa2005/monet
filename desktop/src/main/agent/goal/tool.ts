/**
 * UpdateGoal — the only way out of goal mode.
 *
 * Prose cannot end a goal. If it could, "I think that's everything" would stop
 * the run by accident, and a model that wanted to stop would learn to write it
 * — so completion is a structured signal or it is nothing. The runtime keeps
 * taking turns until this tool says otherwise, or the budget ends it.
 *
 * Two outcomes only. `complete` must come with evidence, because "done"
 * without it is the failure mode goal mode exists to avoid: a confident
 * summary of work that was never verified. `blocked` is the honest exit and
 * costs nothing — the user can change something and resume.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { tunablePrompt } from "../../prompts/index.js";
import { blockGoal } from "./state.js";
import { clearGoal, loadGoal, saveGoal } from "./store.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    status: z
      .enum(["complete", "blocked"])
      .describe(
        "complete = the objective is met and you can point at the evidence. blocked = you cannot get further without the user.",
      ),
    summary: z
      .string()
      .optional()
      .describe(
        "For complete: what was done and HOW YOU KNOW — the test you ran, the file you wrote, the output you checked.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "For blocked: what is in the way, and what the user would have to decide or change.",
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface GoalToolOutput {
  text: string;
  isError?: boolean;
}

const mapResult = (
  data: GoalToolOutput,
  toolUseID: string,
): ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: toolUseID,
  content: data.text,
  is_error: data.isError || undefined,
});

export const UpdateGoalTool = buildTool({
  name: "UpdateGoal",
  searchHint: "finish or block the current autonomous goal",
  maxResultSizeChars: 2_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "UpdateGoal";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-update-goal",
      [
        "End the current goal. Only meaningful while goal mode is running.",
        "",
        'status="complete" — the objective is met. Put the EVIDENCE in summary:',
        "the command you ran and its output, the file you wrote and what it now",
        "contains. A summary that only restates the objective is not evidence,",
        "and this is the tool where that distinction matters most.",
        "",
        'status="blocked" — you cannot get further. Use it when you need a',
        "decision, when the objective cannot be done as written, or when you",
        "notice you are repeating yourself. Blocking early is cheap; burning",
        "twenty turns to arrive at the same place is not.",
        "",
        "Do not call this to report progress — between the two, just keep",
        "working. Saying you are finished in ordinary text does NOT end the",
        "goal; the runtime will start another turn.",
      ].join("\n"),
    );
  },
  async description() {
    return "Mark the current autonomous goal complete or blocked.";
  },
  async call(
    { status, summary, reason }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const sessionId =
      (context as { sessionId?: string }).sessionId || "default";
    const goal = loadGoal(sessionId);
    if (!goal)
      return {
        data: {
          text: "There is no goal in this session, so there is nothing to update.",
          isError: true,
        },
      };

    if (status === "complete") {
      if (!summary?.trim())
        return {
          data: {
            text:
              "A completed goal needs a summary saying what was done and how you " +
              "know it worked. Add the evidence and call this again.",
            isError: true,
          },
        };
      clearGoal(sessionId);
      return {
        data: {
          text: `Goal complete after ${goal.stats.turns} turn(s). Tell the user what you did and what the evidence was.`,
        },
      };
    }

    const detail = reason?.trim() || "No reason given.";
    saveGoal(
      sessionId,
      blockGoal(goal, new Date(), "model-blocked", detail),
    );
    return {
      data: {
        text: `Goal blocked: ${detail}\n\nStop working on it and tell the user what you need from them.`,
      },
    };
  },
  mapToolResultToToolResultBlockParam: mapResult,
  renderToolUseMessage() {
    return null;
  },
});

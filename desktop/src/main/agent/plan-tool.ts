/**
 * Plan-mode tools — the model can hand over a plan and get a verdict.
 *
 * The vendor's ExitPlanModeV2Tool is welded to CLI machinery this app has no
 * equivalent of (agent swarms, teammate mailboxes, agent ids), so this is the
 * same contract rebuilt on the app's own approval round-trip: the model calls
 * ExitPlanMode with its plan, the user sees it and chooses, and the answer
 * comes back as the tool result so the model knows whether to start work or
 * keep planning.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import type { AskPlanApprovalFn } from "../ipc/plan.js";
import { setSessionMode } from "./session-mode.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function out(text: string, isError = false): { data: Output } {
  return { data: { text, isError } };
}

const exitSchema = lazySchema(() =>
  z.strictObject({
    plan: z
      .string()
      .describe(
        "The plan, in markdown. Concise steps the user can actually check — what you will change and why, not a restatement of the request.",
      ),
  }),
);

type ExitSchema = ReturnType<typeof exitSchema>;

export const ExitPlanModeTool = buildTool({
  name: "ExitPlanMode",
  get inputSchema(): ExitSchema {
    return exitSchema();
  },
  searchHint: "present a finished plan for the user to approve",
  maxResultSizeChars: 2_000,
  userFacingName() {
    return "Plan";
  },
  isReadOnly() {
    return true; // shows a dialog; changes nothing on disk
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-exit-plan-mode",
      [
        "Present a finished implementation plan and ask the user to approve it.",
        "",
        "Use this ONLY when you are in plan mode and have finished researching:",
        "you know which files change and how. Do not use it to ask a question",
        "mid-research, and do not use it for work that needs no plan.",
        "",
        "The user answers with one of: approve (you may start, risky actions",
        "still ask), approve and auto-accept edits (workspace edits stop",
        "prompting), or keep planning (you get their note and revise).",
        "The result tells you which — do not start work until it says you may.",
      ].join("\n"),
    );
  },
  async description() {
    return "Present a finished plan for the user to approve before making changes.";
  },
  // No checkPermissions override: buildTool defaults to allow, which is what
  // we want — the approval dialog IS the permission prompt, and a second one
  // would be asking the user to approve being asked.
  async call(input: z.infer<ExitSchema>, context: ToolUseContext) {
    const ask = (context as { askPlanApproval?: AskPlanApprovalFn })
      .askPlanApproval;
    const sessionId = (context as { sessionId?: string }).sessionId ?? "";
    if (!ask) {
      return out(
        "No approval channel is available, so the plan can't be shown. Tell the user the plan in your reply and ask them to switch out of plan mode themselves.",
        true,
      );
    }
    const { decision, feedback } = await ask(input.plan);
    if (decision === "keep-planning") {
      return out(
        feedback
          ? `The user did NOT approve the plan. They said: ${feedback}\n\nRevise the plan and call ExitPlanMode again. Do not start making changes.`
          : "The user did NOT approve the plan. Keep planning — ask what they want changed. Do not start making changes.",
      );
    }
    // Approval changes the mode for the REST OF THIS TURN; without it the
    // model would be told to proceed and then hit plan-mode blocks on its
    // very next tool call.
    const mode = decision === "approve-auto" ? "acceptEdits" : "default";
    if (sessionId) setSessionMode(sessionId, mode);
    return out(
      decision === "approve-auto"
        ? "The user approved the plan and turned on auto-accept for edits in the workspace. Start working through it now."
        : "The user approved the plan. Start working through it now; risky actions will still ask for confirmation.",
    );
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});

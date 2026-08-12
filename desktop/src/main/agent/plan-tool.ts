/**
 * Plan-mode tools — the plan is a DOCUMENT the whole session works against.
 *
 * ExitPlanMode used to flash markdown in a dialog and forget it. Now it
 * writes a plan document (plan/store.ts): title, summary, body, todo list.
 * The renderer shows it as a card in the chat and as a dock panel; approval
 * still round-trips through the same channel, but what the user approves is
 * the document, and "Build" flips it to building.
 *
 * UpdatePlan is how work reports back: any agent — the main loop or a
 * sub-agent under its own name — ticks todos, leaves notes on items, and
 * comments on the plan. The store closes the plan when the last box is
 * ticked; the injector (plan/inject.ts) keeps the model honest about the
 * list every turn while it builds.
 */

import { BrowserWindow } from "electron";
import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import type { AskPlanApprovalFn } from "../ipc/plan.js";
import {
  addComment,
  currentPlan,
  revisePlan,
  setPlanStatus,
  setTodoStatus,
  type PlanTodoStatus,
} from "../plan/store.js";
import { setSessionMode } from "./session-mode.js";
import type { UiPermissionMode } from "./vendor-tools.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function out(text: string, isError = false): { data: Output } {
  return { data: { text, isError } };
}

function ctxOf(context: ToolUseContext): {
  sessionId: string;
  agentLabel: string;
  permissionMode: string;
  askPlanApproval?: AskPlanApprovalFn;
} {
  const c = context as {
    sessionId?: string;
    agentLabel?: string;
    permissionMode?: string;
    askPlanApproval?: AskPlanApprovalFn;
  };
  return {
    sessionId: c.sessionId ?? "",
    agentLabel: c.agentLabel ?? "agent",
    permissionMode: c.permissionMode ?? "default",
    askPlanApproval: c.askPlanApproval,
  };
}

/** Tell every window the session's mode changed, so the composer's selector
 * follows a mode the MODEL switched (plan entered/exited mid-turn). */
function broadcastMode(sessionId: string, mode: string): void {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("plan:modeChanged", { sessionId, mode });
}

// ── EnterPlanMode ─────────────────────────────────────────────────────

const enterSchema = lazySchema(() =>
  z.strictObject({
    reason: z
      .string()
      .optional()
      .describe("One line: why this task deserves a plan first."),
  }),
);

type EnterSchema = ReturnType<typeof enterSchema>;

export const EnterPlanModeTool = buildTool({
  name: "EnterPlanMode",
  get inputSchema(): EnterSchema {
    return enterSchema();
  },
  searchHint: "switch into plan mode before a larger task",
  maxResultSizeChars: 1_000,
  userFacingName() {
    return "Plan mode";
  },
  isReadOnly() {
    return true; // changes the session's mode, nothing on disk
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return tunablePrompt(
      "tool-enter-plan-mode",
      [
        "Switch this chat into plan mode yourself. Use it when the user asks",
        "for a plan in prose (\"давай спланируем\", \"make a plan first\"), or",
        "when the task is large enough that they should approve an approach",
        "before you touch files.",
        "",
        "After calling it: research without modifying anything, then present",
        "the plan with ExitPlanMode. Do not use it for small tasks the user",
        "just wants done.",
      ].join("\n"),
    );
  },
  async description() {
    return "Switch the chat into plan mode: research first, then present a plan for approval.";
  },
  async call(_input: z.infer<EnterSchema>, context: ToolUseContext) {
    const { sessionId, permissionMode } = ctxOf(context);
    if (!sessionId) return out("No session to switch.", true);
    if (permissionMode === "plan")
      return out("Already in plan mode — research, then call ExitPlanMode.");
    // The override is keyed to the selector's CURRENT value: if the user
    // flips the selector by hand later, their choice wins (session-mode.ts).
    setSessionMode(sessionId, "plan", permissionMode as UiPermissionMode);
    broadcastMode(sessionId, "plan");
    return out(
      "Plan mode is on. Research the task WITHOUT modifying anything, then present the plan by calling ExitPlanMode (title, one-line summary, detailed markdown, todo list).",
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

// ── ExitPlanMode ──────────────────────────────────────────────────────

const exitSchema = lazySchema(() =>
  z.strictObject({
    title: z
      .string()
      .describe('Short imperative title, e.g. "Add GitHub OAuth authentication".'),
    summary: z
      .string()
      .optional()
      .describe("One sentence under the title: what this plan achieves."),
    plan: z
      .string()
      .describe(
        "The detailed plan, in markdown. Concise steps the user can actually check — what you will change and why, not a restatement of the request.",
      ),
    todos: z
      .array(z.string())
      .min(1)
      .describe(
        "The checklist the user will watch while you build: one entry per unit of work, in execution order.",
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
    return true; // writes the plan document, nothing in the workspace
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
        "The plan becomes a document the user keeps: give it a real title, a",
        "one-line summary, the detailed markdown, and a todo list — the todos",
        "are the progress bar the user watches while you build, so make each",
        "one a checkable unit of work.",
        "",
        "The user answers with one of: build (you may start, risky actions",
        "still ask), build and auto-accept edits (workspace edits stop",
        "prompting), or keep planning (you get their note and revise — call",
        "ExitPlanMode again with the revised plan).",
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
    const { sessionId, askPlanApproval: ask } = ctxOf(context);
    if (!ask) {
      return out(
        "No approval channel is available, so the plan can't be shown. Tell the user the plan in your reply and ask them to switch out of plan mode themselves.",
        true,
      );
    }
    // Write (or revise) the document first — the card and the panel render
    // from the store; the approval request only points at it.
    const doc = sessionId
      ? revisePlan(sessionId, {
          title: input.title,
          summary: input.summary,
          body: input.plan,
          todos: input.todos,
        })
      : null;
    const { decision, feedback } = await ask(input.plan, doc?.id);
    if (decision === "keep-planning") {
      if (doc) {
        setPlanStatus(doc.id, "draft");
        if (feedback)
          addComment(doc.id, { author: "user", kind: "user", text: feedback });
      }
      return out(
        feedback
          ? `The user did NOT approve the plan. They said: ${feedback}\n\nRevise the plan and call ExitPlanMode again. Do not start making changes.`
          : "The user did NOT approve the plan. Keep planning — ask what they want changed. Do not start making changes.",
      );
    }
    if (doc) setPlanStatus(doc.id, "building");
    // Approval changes the mode for the REST OF THIS TURN; without it the
    // model would be told to proceed and then hit plan-mode blocks on its
    // very next tool call.
    const mode = decision === "approve-auto" ? "acceptEdits" : "default";
    if (sessionId) {
      setSessionMode(sessionId, mode);
      // The selector follows: idempotent when the card's respond() already
      // set it, and the only sync at all when the model entered plan mode
      // itself and the renderer never saw a change until now.
      broadcastMode(sessionId, mode);
    }
    return out(
      (decision === "approve-auto"
        ? "The user approved the plan and turned on auto-accept for edits in the workspace. Start working through it now."
        : "The user approved the plan. Start working through it now; risky actions will still ask for confirmation.") +
        (doc
          ? " Keep the plan's todo list truthful as you go: UpdatePlan marks items in_progress / completed / skipped."
          : ""),
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

// ── UpdatePlan ────────────────────────────────────────────────────────

const updateSchema = lazySchema(() =>
  z.strictObject({
    todo: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based index of the todo to update, as shown in the reminder."),
    status: z
      .enum(["in_progress", "completed", "skipped", "pending"])
      .optional()
      .describe("New status for that todo. Defaults to completed."),
    note: z
      .string()
      .optional()
      .describe(
        "Short remark attached to that todo — REQUIRED when skipping (say why).",
      ),
    comment: z
      .string()
      .optional()
      .describe(
        "A remark on the plan as a whole: what you did, what you could not do, what changed. Shown in the plan's comment thread under your name.",
      ),
    done: z
      .boolean()
      .optional()
      .describe(
        "Mark the whole plan done. Usually unnecessary — ticking the last todo closes it.",
      ),
  }),
);

type UpdateSchema = ReturnType<typeof updateSchema>;

export const UpdatePlanTool = buildTool({
  name: "UpdatePlan",
  get inputSchema(): UpdateSchema {
    return updateSchema();
  },
  searchHint: "tick a plan todo, leave a note or comment on the plan",
  maxResultSizeChars: 1_000,
  userFacingName() {
    return "Update plan";
  },
  isReadOnly() {
    return true; // touches only the plan document
  },
  isConcurrencySafe() {
    return false; // parallel agents' ticks still serialize through main
  },
  async prompt() {
    return tunablePrompt(
      "tool-update-plan",
      [
        "Update the session's plan document while working through an approved",
        "plan: mark a todo in_progress when you start it, completed when it is",
        "actually done, skipped (with a note saying why) when you decide not",
        "to do it. Use `comment` for remarks about the plan as a whole — what",
        "you finished, what you could not do, what the user should look at.",
        "Sub-agents: report what YOU did under your own name before you finish.",
        "Do not mark anything completed that you have not verified.",
      ].join("\n"),
    );
  },
  async description() {
    return "Tick off plan todos and leave remarks on the plan document.";
  },
  async call(input: z.infer<UpdateSchema>, context: ToolUseContext) {
    const { sessionId, agentLabel } = ctxOf(context);
    const plan = sessionId ? currentPlan(sessionId) : null;
    if (!plan) return out("There is no plan document in this session.", true);
    if (plan.status !== "building" && plan.status !== "done")
      return out(
        "The plan has not been approved yet — present it with ExitPlanMode first.",
        true,
      );

    const did: string[] = [];
    if (input.todo !== undefined) {
      const t = plan.todos[input.todo - 1];
      if (!t)
        return out(
          `No todo #${input.todo} — the plan has ${plan.todos.length}.`,
          true,
        );
      const status: PlanTodoStatus = input.status ?? "completed";
      if (status === "skipped" && !input.note && !t.note)
        return out("Skipping needs a note: say why in `note`.", true);
      setTodoStatus(plan.id, t.id, status, agentLabel, input.note);
      did.push(`todo #${input.todo} → ${status}`);
    } else if (input.note) {
      return out(
        "`note` attaches to a todo — pass `todo` too, or use `comment`.",
        true,
      );
    }
    if (input.comment) {
      addComment(plan.id, {
        author: agentLabel,
        kind: "agent",
        text: input.comment,
      });
      did.push("comment added");
    }
    if (input.done) {
      setPlanStatus(plan.id, "done");
      did.push("plan marked done");
    }
    if (did.length === 0)
      return out("Nothing to do — pass `todo`, `comment` or `done`.", true);

    const fresh = sessionId ? currentPlan(sessionId) : null;
    const left =
      fresh?.todos.filter(
        (t) => t.status !== "completed" && t.status !== "skipped",
      ).length ?? 0;
    return out(
      `Plan updated (${did.join(", ")}). ${
        fresh?.status === "done"
          ? "The plan is complete."
          : `${left} todo${left === 1 ? "" : "s"} remaining.`
      }`,
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

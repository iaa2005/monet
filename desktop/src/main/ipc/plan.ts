/**
 * Plan approval round-trip.
 *
 * Plan mode used to be a dead end: non-read-only tools were blocked with a
 * message telling the model to "present the plan and let the user switch
 * modes", so the user had to notice that and flip the selector by hand. The
 * model had no way to hand over a plan and no way to learn the verdict.
 *
 * This mirrors ask-user.ts: main sends `plan:request`, the renderer shows the
 * plan with the approval choices, and replies on `plan:response`.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import {
  addComment,
  currentPlan,
  getPlan,
  listPlans,
  planToMarkdown,
  setPlanStatus,
  setTodoStatus,
  type PlanTodoStatus,
} from "../plan/store.js";

export interface PlanApprovalRequest {
  id: string;
  /** Markdown plan the model wrote. */
  plan: string;
  /** The plan DOCUMENT this approval is about (plan/store.ts). The chat card
   * renders from the document; this string is the fallback. */
  planId?: string;
  /** Which chat asked — the card offers Build only in that transcript. */
  sessionId?: string;
}

export type PlanDecision =
  /** Proceed, asking before risky actions. */
  | "approve"
  /** Proceed and stop asking about edits in the workspace. */
  | "approve-auto"
  /** Not yet — the model keeps planning, with the user's note. */
  | "keep-planning"
  /** Declined — do not build, end the turn; the plan stays a draft and the
   * user follows up in chat when they are ready. */
  | "cancel";

export interface PlanApprovalResult {
  decision: PlanDecision;
  /** Free-text the user typed when sending the model back to planning. */
  feedback?: string;
}

interface PlanResponsePayload {
  id: string;
  decision?: PlanDecision;
  feedback?: string;
}

export type AskPlanApprovalFn = (
  plan: string,
  planId?: string,
) => Promise<PlanApprovalResult>;

/** Same budget as ask-user: long enough to actually read a plan. */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export function askPlanApprovalFromRenderer(
  win: BrowserWindow,
  plan: string,
  planId?: string,
  sessionId?: string,
): Promise<PlanApprovalResult> {
  const request: PlanApprovalRequest = {
    id: randomUUID(),
    plan,
    planId,
    sessionId,
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PlanApprovalResult): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("plan:response", handler);
      clearTimeout(timer);
      // However it ended — answered, timed out, window gone — tell the
      // renderer the round-trip is over. Without this a TIMED-OUT request
      // stayed pending in the store forever, and the composer (which answers
      // a pending request instead of sending) would swallow every later
      // message into a settled promise that no longer listens.
      if (!win.isDestroyed())
        win.webContents.send("plan:requestSettled", request.id);
      resolve(result);
    };
    const handler = (
      _e: Electron.IpcMainEvent,
      payload: PlanResponsePayload,
    ): void => {
      if (payload.id !== request.id) return;
      finish({
        decision: payload.decision ?? "keep-planning",
        feedback: payload.feedback,
      });
    };

    ipcMain.on("plan:response", handler);
    // Timing out must NOT approve anything — an unanswered plan stays a plan.
    const timer = setTimeout(
      () => finish({ decision: "keep-planning" }),
      DECISION_TIMEOUT_MS,
    );

    if (win.isDestroyed()) {
      finish({ decision: "keep-planning" });
      return;
    }
    win.webContents.send("plan:request", request);
  });
}

/**
 * The plan DOCUMENT's own IPC — read it, comment on it, tick a box by hand.
 * Every mutation broadcasts `plan:changed` from the store, so the chat card
 * and the dock panel redraw together.
 */
export function registerPlanIPC(): void {
  ipcMain.handle("plan:current", (_e, sessionId: string) =>
    currentPlan(sessionId),
  );
  ipcMain.handle("plan:list", (_e, sessionId: string) => listPlans(sessionId));
  ipcMain.handle("plan:get", (_e, planId: string) => getPlan(planId));
  ipcMain.handle(
    "plan:comment",
    (_e, planId: string, text: string, todoId?: string) =>
      addComment(planId, { author: "user", kind: "user", text, todoId }),
  );
  // The user can move a box themselves — the same honesty rule as the agent:
  // the injector shows the model the list as it now stands.
  ipcMain.handle(
    "plan:setTodo",
    (_e, planId: string, todoId: string, status: PlanTodoStatus) =>
      setTodoStatus(planId, todoId, status, "user"),
  );
  ipcMain.handle("plan:markdown", (_e, planId: string) => {
    const plan = getPlan(planId);
    return plan ? planToMarkdown(plan) : null;
  });
  // "Keep planning" from the card without feedback text, or archiving a stale
  // ready plan back to draft.
  ipcMain.handle("plan:setStatus", (_e, planId: string, status: string) =>
    status === "draft" || status === "done"
      ? setPlanStatus(planId, status)
      : null,
  );
}

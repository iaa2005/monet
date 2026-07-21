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

export interface PlanApprovalRequest {
  id: string;
  /** Markdown plan the model wrote. */
  plan: string;
}

export type PlanDecision =
  /** Proceed, asking before risky actions. */
  | "approve"
  /** Proceed and stop asking about edits in the workspace. */
  | "approve-auto"
  /** Not yet — the model keeps planning, with the user's note. */
  | "keep-planning";

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

export type AskPlanApprovalFn = (plan: string) => Promise<PlanApprovalResult>;

/** Same budget as ask-user: long enough to actually read a plan. */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export function askPlanApprovalFromRenderer(
  win: BrowserWindow,
  plan: string,
): Promise<PlanApprovalResult> {
  const request: PlanApprovalRequest = { id: randomUUID(), plan };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PlanApprovalResult): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("plan:response", handler);
      clearTimeout(timer);
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

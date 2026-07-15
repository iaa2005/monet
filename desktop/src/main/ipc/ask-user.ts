/**
 * Ask-user IPC — the main→renderer question round-trip (mirrors permissions).
 *
 * When the AskUserQuestion tool runs, the agent calls askUserFromRenderer(),
 * which pushes an `ask:request` to the renderer (AskUserDialog) and resolves
 * once the user answers via `ask:response`. Tool execution is sequential in the
 * agent loop, so a single pending question at a time is fine.
 */

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionSpec {
  /** The full question text. */
  question: string;
  /** Very short chip label (e.g. "Auth method"). */
  header: string;
  /** 2–4 mutually-exclusive (or, with multiSelect, combinable) choices. */
  options: AskUserOption[];
  /** Allow selecting more than one option. */
  multiSelect: boolean;
}

export interface AskUserRequest {
  id: string;
  questions: AskUserQuestionSpec[];
}

export interface AskUserAnswer {
  header: string;
  question: string;
  /** Labels the user chose (includes any free-text "Other" entry). */
  selected: string[];
}

export type AskUserResult =
  | { cancelled: true }
  | { cancelled: false; answers: AskUserAnswer[] };

/** Renderer's reply payload for `ask:response`. */
interface AskUserResponsePayload {
  id: string;
  cancelled: boolean;
  answers?: AskUserAnswer[];
}

export type AskUserFn = (
  questions: AskUserQuestionSpec[],
) => Promise<AskUserResult>;

/** Human decision timeout — long enough to read several questions and choose. */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export function askUserFromRenderer(
  win: BrowserWindow,
  questions: AskUserQuestionSpec[],
): Promise<AskUserResult> {
  const request: AskUserRequest = { id: randomUUID(), questions };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AskUserResult): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("ask:response", handler);
      clearTimeout(timer);
      resolve(result);
    };
    const handler = (
      _e: Electron.IpcMainEvent,
      payload: AskUserResponsePayload,
    ): void => {
      if (payload.id !== request.id) return; // not our question
      finish(
        payload.cancelled
          ? { cancelled: true }
          : { cancelled: false, answers: payload.answers ?? [] },
      );
    };

    ipcMain.on("ask:response", handler);
    const timer = setTimeout(() => finish({ cancelled: true }), DECISION_TIMEOUT_MS);

    if (win.isDestroyed()) {
      finish({ cancelled: true });
      return;
    }
    win.webContents.send("ask:request", request);
  });
}

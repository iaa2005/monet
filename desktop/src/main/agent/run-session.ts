/**
 * Which session's run is executing THIS code, wherever it is.
 *
 * Browser tools open tabs from deep inside the tool stack, and the tab must
 * land on the desk of the chat that asked for it — not whatever chat is on
 * screen. Threading a sessionId through every tool signature would touch
 * dozens of files; an AsyncLocalStorage scope around the run touches one.
 */

import { AsyncLocalStorage } from "async_hooks";

export const runSession = new AsyncLocalStorage<string>();

/** The session of the currently-executing run, if any. */
export function currentRunSession(): string | undefined {
  return runSession.getStore();
}

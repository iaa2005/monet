/**
 * Stats IPC — usage/activity stats computed from the sessions DB.
 */
import { ipcMain } from "electron";
import { getSessionStore } from "../session-store.js";

export function registerStatsIPC(): void {
  ipcMain.handle("stats:get", (_e, rangeDays?: number) =>
    getSessionStore().stats(rangeDays),
  );
}

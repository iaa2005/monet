/**
 * IPC for the durable task log (Background tasks panel).
 *
 * Read-and-clear only: rows are WRITTEN by the agent loop, which is the only
 * thing that knows a tool ran. A renderer that could insert rows would let a
 * reloaded window duplicate history it merely re-observed.
 */

import { ipcMain } from "electron";
import { clearFinished, listTasks, settleOrphans } from "../session/task-log.js";

export function registerTasksIPC(): void {
  // Rows left "running" belong to a process that is gone — the app was killed
  // mid-call. Settled once at startup so the panel doesn't open on ghosts
  // spinning since last week.
  const orphans = settleOrphans();
  if (orphans > 0)
    console.log(`[tasks] settled ${orphans} task(s) orphaned by a previous run`);

  ipcMain.handle("tasks:list", (_e, limit?: number) => listTasks(limit ?? 500));
  ipcMain.handle("tasks:clear", () => {
    clearFinished();
    return true;
  });
}

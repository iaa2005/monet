/**
 * Memory IPC — Settings → Memory page: toggles, file table, editor, and the
 * "tell Code Monet to remember…" note box.
 */

import { ipcMain } from "electron";
import {
  deleteMemoryFile,
  getMemoryConfig,
  listMemoryFiles,
  readMemoryFile,
  setMemoryConfig,
  writeMemoryFile,
  type MemoryConfig,
} from "../memory/store.js";
import { addMemoryNote } from "../memory/extract.js";
import { getConsolidationState, runConsolidation } from "../memory/consolidate.js";
import { pendingBulletCount } from "../memory/daily-log.js";
import { resetVendorTools } from "../agent/vendor-tools.js";

export function registerMemoryIPC(): void {
  ipcMain.handle("memory:getConfig", (): MemoryConfig => getMemoryConfig());
  ipcMain.handle(
    "memory:setConfig",
    (_e, patch: Partial<MemoryConfig>): MemoryConfig => {
      const next = setMemoryConfig(patch);
      // The SearchPastChats tool is gated by searchChats — refresh the toolset.
      resetVendorTools();
      return next;
    },
  );
  ipcMain.handle("memory:list", () => listMemoryFiles());
  ipcMain.handle("memory:read", (_e, id: string) => readMemoryFile(id));
  ipcMain.handle(
    "memory:write",
    (_e, id: string, data: { name: string; summary: string; body: string }) =>
      writeMemoryFile(id, data),
  );
  ipcMain.handle("memory:delete", (_e, id: string) => deleteMemoryFile(id));
  ipcMain.handle("memory:addNote", (_e, note: string) => addMemoryNote(note));

  // Consolidation: the nightly pass runs itself, but the user can see when it
  // last ran and trigger one now (force skips the time/signal gates).
  ipcMain.handle("memory:consolidationState", () => {
    const s = getConsolidationState();
    return { ...s, pending: pendingBulletCount(s.lastConsolidatedAt) };
  });
  ipcMain.handle("memory:consolidate", () => runConsolidation({ force: true }));

  // Project lessons: the per-workspace half of the dream (memory/lessons.ts).
  // Rollback is the trust story — an automatic memory a cheap model writes is
  // only acceptable if a bad night is one click to undo.
  ipcMain.handle("memory:lessonsList", async () => {
    const { listLessons } = await import("../memory/lessons.js");
    return listLessons();
  });
  ipcMain.handle("memory:lessonsState", async () => {
    const { getLessonsState } = await import("../memory/lessons.js");
    return getLessonsState();
  });
  ipcMain.handle("memory:lessonsRollback", async (_e, workspace: string) => {
    const { rollbackLessons } = await import("../memory/lessons.js");
    return rollbackLessons(workspace);
  });
  ipcMain.handle("memory:lessonsDelete", async (_e, workspace: string) => {
    const { deleteLessons } = await import("../memory/lessons.js");
    return deleteLessons(workspace);
  });
  ipcMain.handle("memory:lessonsDream", async () => {
    const { runLessonsDream } = await import("../memory/lessons.js");
    return runLessonsDream({ force: true });
  });

  // Hooks live in .claude/settings.json and are read from a snapshot taken at
  // startup, so an edit made while the app runs needs an explicit reload.
  ipcMain.handle("hooks:reload", async () => {
    try {
      const { reloadHooks, listConfiguredHooks } = await import(
        "../agent/tool-hooks.js"
      );
      await reloadHooks();
      return { ok: true, hooks: await listConfiguredHooks() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

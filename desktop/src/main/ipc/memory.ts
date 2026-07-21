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

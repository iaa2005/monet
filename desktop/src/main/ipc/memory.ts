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
}

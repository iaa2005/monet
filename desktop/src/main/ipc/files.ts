/**
 * File IPC handlers — read/write/edit/list files.
 */

import { ipcMain, dialog } from "electron";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { join } from "path";

export function registerFilesIPC(): void {
  ipcMain.handle("files:read", async (_event, filePath: string) => {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return readFileSync(filePath, "utf-8");
  });

  ipcMain.handle(
    "files:write",
    async (_event, filePath: string, content: string) => {
      writeFileSync(filePath, content, "utf-8");
      return { ok: true };
    },
  );

  ipcMain.handle("files:list", async (_event, dirPath: string) => {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      path: join(dirPath, e.name),
    }));
  });

  ipcMain.handle("files:exists", async (_event, filePath: string) => {
    return existsSync(filePath);
  });

  ipcMain.handle("files:pick-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("files:stat", async (_event, filePath: string) => {
    const s = statSync(filePath);
    return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
  });
}

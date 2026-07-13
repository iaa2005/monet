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

/** Normalise Unix-style paths (/c/Users/...) to Windows (C:\Users\...). */
function normPath(p: string): string {
  if (process.platform !== "win32") return p;
  // MSYS/Git Bash sends /c/Users/foo → C:/Users/foo
  if (/^\/[a-zA-Z]\//.test(p)) {
    return p.slice(1, 2).toUpperCase() + ":" + p.slice(2).replace(/\//g, "\\");
  }
  // Convert forward slashes on Windows
  return p.replace(/\//g, "\\");
}

export function registerFilesIPC(): void {
  ipcMain.handle("files:read", async (_event, filePath: string) => {
    const p = normPath(filePath);
    if (!existsSync(p)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return readFileSync(p, "utf-8");
  });

  ipcMain.handle(
    "files:write",
    async (_event, filePath: string, content: string) => {
      writeFileSync(normPath(filePath), content, "utf-8");
      return { ok: true };
    },
  );

  ipcMain.handle("files:list", async (_event, dirPath: string) => {
    const p = normPath(dirPath);
    const entries = readdirSync(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      path: join(p, e.name),
    }));
  });

  ipcMain.handle("files:exists", async (_event, filePath: string) => {
    return existsSync(normPath(filePath));
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

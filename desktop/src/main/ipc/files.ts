/**
 * File IPC handlers — read/write/edit/list files.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { basename, join } from "path";

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

  // Raw bytes (base64) for rich previews of ANY file the user opens from the
  // file tree (images/pdf/docx/xlsx/audio/video) — the artifacts:* readers
  // refuse paths outside the artifacts dir by design.
  ipcMain.handle(
    "files:readBytes",
    (_e, filePath: string): { ok: boolean; base64?: string; error?: string } => {
      try {
        const p = normPath(filePath);
        const buf = readFileSync(p);
        if (buf.length > 40 * 1024 * 1024)
          return { ok: false, error: "File is too large to preview (40MB)" };
        return { ok: true, base64: buf.toString("base64") };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "read failed",
        };
      }
    },
  );

  // Save-as: copy any readable file to a user-chosen location (viewer's
  // Download button for tree files; artifacts have their own handler).
  ipcMain.handle(
    "files:saveAs",
    async (
      _e,
      filePath: string,
      name?: string,
    ): Promise<{ ok: boolean; savedTo?: string; error?: string }> => {
      try {
        const p = normPath(filePath);
        if (!existsSync(p)) return { ok: false, error: "not found" };
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        const res = await dialog.showSaveDialog(win!, {
          defaultPath: name || basename(p),
        });
        if (res.canceled || !res.filePath) return { ok: false };
        copyFileSync(p, res.filePath);
        return { ok: true, savedTo: res.filePath };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save failed",
        };
      }
    },
  );
}

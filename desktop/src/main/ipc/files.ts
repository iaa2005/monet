/**
 * File IPC handlers — read/write/edit/list files.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import {
  access,
  copyFile,
  readdir,
  readFile,
  stat,
  writeFile,
} from "fs/promises";
import { basename, join } from "path";

/** Normalise Unix-style paths (/c/Users/...) to Windows (C:\Users\...). */
const MAX_TEXT_BYTES = 400_000;
const MAX_PREVIEW_BYTES = 40 * 1024 * 1024;

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
    try {
      const info = await stat(p);
      if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
      if (info.size > MAX_TEXT_BYTES)
        throw new Error("File is too large to preview (400KB)");
      return await readFile(p, "utf-8");
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("File is too large"))
        throw err;
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT")
        throw new Error(`File not found: ${filePath}`);
      throw err;
    }
  });

  ipcMain.handle(
    "files:write",
    async (_event, filePath: string, content: string) => {
      await writeFile(normPath(filePath), content, "utf-8");
      return { ok: true };
    },
  );

  ipcMain.handle("files:list", async (_event, dirPath: string) => {
    const p = normPath(dirPath);
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      path: join(p, e.name),
    }));
  });

  ipcMain.handle("files:exists", async (_event, filePath: string) => {
    try {
      await access(normPath(filePath));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("files:pick-directory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("files:stat", async (_event, filePath: string) => {
    const s = await stat(normPath(filePath));
    return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
  });

  // Raw bytes (base64) for rich previews of ANY file the user opens from the
  // file tree (images/pdf/docx/xlsx/audio/video) — the artifacts:* readers
  // refuse paths outside the artifacts dir by design.
  ipcMain.handle(
    "files:readBytes",
    async (
      _e,
      filePath: string,
    ): Promise<{ ok: boolean; base64?: string; error?: string }> => {
      try {
        const p = normPath(filePath);
        const info = await stat(p);
        if (!info.isFile()) return { ok: false, error: "not a file" };
        if (info.size > MAX_PREVIEW_BYTES)
          return { ok: false, error: "File is too large to preview (40MB)" };
        const buf = await readFile(p);
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
        try {
          await access(p);
        } catch {
          return { ok: false, error: "not found" };
        }
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        const res = await dialog.showSaveDialog(win!, {
          defaultPath: name || basename(p),
        });
        if (res.canceled || !res.filePath) return { ok: false };
        await copyFile(p, res.filePath);
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

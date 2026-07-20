/**
 * File IPC handlers — read/write/edit/list files.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import {
  access,
  copyFile,
  open,
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

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** Log operation context without echoing local paths or file contents. */
function logFilesError(operation: string, err: unknown): void {
  console.error(`[files] ${operation} failed`, {
    code: errorCode(err) ?? "unknown",
    errorType: err instanceof Error ? err.name : typeof err,
  });
}

function publicError(operation: string, filePath: string, err: unknown): Error {
  const code = errorCode(err);
  const name = basename(filePath) || "file";
  if (code === "ENOENT") return new Error(`${operation}: ${name} not found`);
  if (code === "EACCES" || code === "EPERM")
    return new Error(`${operation}: permission denied for ${name}`);
  if (err instanceof Error && err.message.startsWith("Not a file"))
    return new Error(`${operation}: ${name} is not a file`);
  if (err instanceof Error && err.message.startsWith("File is too large"))
    return err;
  return new Error(`${operation} failed for ${name}`);
}

export function registerFilesIPC(): void {
  ipcMain.handle("files:read", async (_event, filePath: string) => {
    const p = normPath(filePath);
    try {
      const info = await stat(p);
      if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
      // Oversized files are TRUNCATED, never refused: a 2MB log is the kind of
      // file a user most wants to peek at, and the size cap exists to protect
      // memory, not to hide the first page. Only the capped prefix is read.
      if (info.size > MAX_TEXT_BYTES) {
        const fh = await open(p, "r");
        try {
          const buf = Buffer.alloc(MAX_TEXT_BYTES);
          const { bytesRead } = await fh.read(buf, 0, MAX_TEXT_BYTES, 0);
          const shown = Math.round(MAX_TEXT_BYTES / 1000);
          const total = Math.round(info.size / 1000);
          return (
            buf.subarray(0, bytesRead).toString("utf-8") +
            `\n\n… (truncated — showing first ${shown}KB of ${total}KB)`
          );
        } finally {
          await fh.close();
        }
      }
      return await readFile(p, "utf-8");
    } catch (err) {
      logFilesError("read", err);
      throw publicError("Read file", filePath, err);
    }
  });

  ipcMain.handle(
    "files:write",
    async (_event, filePath: string, content: string) => {
      try {
        await writeFile(normPath(filePath), content, "utf-8");
        return { ok: true };
      } catch (err) {
        logFilesError("write", err);
        throw publicError("Write file", filePath, err);
      }
    },
  );

  ipcMain.handle("files:list", async (_event, dirPath: string) => {
    const p = normPath(dirPath);
    try {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        path: join(p, e.name),
      }));
    } catch (err) {
      logFilesError("list", err);
      throw publicError("List directory", dirPath, err);
    }
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
    try {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    } catch (err) {
      logFilesError("pick-directory", err);
      throw new Error("Pick directory failed");
    }
  });

  ipcMain.handle("files:stat", async (_event, filePath: string) => {
    try {
      const s = await stat(normPath(filePath));
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      logFilesError("stat", err);
      throw publicError("Stat file", filePath, err);
    }
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
        if (!info.isFile()) {
          const error = new Error("not a file");
          logFilesError("readBytes", error);
          return { ok: false, error: error.message };
        }
        if (info.size > MAX_PREVIEW_BYTES) {
          const error = new Error("File is too large to preview (40MB)");
          logFilesError("readBytes", error);
          return { ok: false, error: error.message };
        }
        const buf = await readFile(p);
        return { ok: true, base64: buf.toString("base64") };
      } catch (err) {
        logFilesError("readBytes", err);
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
        } catch (err) {
          logFilesError("saveAs", err);
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
        logFilesError("saveAs", err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save failed",
        };
      }
    },
  );
}

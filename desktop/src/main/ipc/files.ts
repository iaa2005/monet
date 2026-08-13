/**
 * File IPC handlers — read/write/edit/list files.
 */

import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import {
  access,
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";
import { searchFiles } from "../workspace/search.js";
import {
  appendIgnoreLine,
  gitignoreLineFor,
  isPathInside,
  pasteTargetPath,
  uniqueDuplicatePath,
  validateEntryName,
} from "./file-ops.js";

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

  /**
   * The binary counterpart of files:write — base64 in, bytes on disk.
   *
   * A spreadsheet edited in the viewer has to go back as a workbook, and
   * `files:write` is utf-8: handing it the bytes of an .xlsx corrupts every
   * one of them that is not valid UTF-8, which is most of them.
   */
  ipcMain.handle(
    "files:writeBytes",
    async (_event, filePath: string, base64: string) => {
      try {
        await writeFile(normPath(filePath), Buffer.from(base64, "base64"));
        return { ok: true };
      } catch (err) {
        logFilesError("writeBytes", err);
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

  // Walks the real folder rather than filtering what the tree has loaded: the
  // tree is lazy, so an on-screen filter would answer "no matches" for anything
  // inside a collapsed folder.
  ipcMain.handle(
    "files:search",
    async (_event, rootPath: string, query: string, includeHidden?: boolean) => {
      try {
        return await searchFiles(normPath(rootPath), query, {
          includeHidden: includeHidden === true,
        });
      } catch (err) {
        logFilesError("search", err);
        return { hits: [], truncated: false };
      }
    },
  );

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

  // ── File management — what the tree's context menu does ───────────────
  // Thin: every decision (legal names, duplicate numbering, gitignore lines)
  // lives in file-ops.ts where the probe reaches it. Deleting always goes to
  // the OS trash, never unlink — a right-click in a tree must be recoverable.

  const fail = (err: unknown, what: string): { ok: false; error: string } => {
    logFilesError(what, err);
    return { ok: false, error: err instanceof Error ? err.message : `${what} failed` };
  };

  ipcMain.handle(
    "files:create",
    async (
      _e,
      parentDir: string,
      name: string,
      isDirectory: boolean,
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const valid = validateEntryName(name);
      if (!valid.ok) return { ok: false, error: valid.error };
      const target = join(normPath(parentDir), name.trim());
      try {
        if (existsSync(target))
          return { ok: false, error: `${basename(target)} already exists.` };
        if (isDirectory) await mkdir(target, { recursive: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, "", { flag: "wx" });
        }
        return { ok: true, path: target };
      } catch (err) {
        return fail(err, "create");
      }
    },
  );

  ipcMain.handle(
    "files:rename",
    async (
      _e,
      filePath: string,
      newName: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      // Rename stays in place — a path with separators is a move, and moves
      // deserve a deliberate surface, not a slip in a rename box.
      if (/[\\/]/.test(newName))
        return { ok: false, error: "Rename cannot contain / — it stays in this folder." };
      const valid = validateEntryName(newName);
      if (!valid.ok) return { ok: false, error: valid.error };
      const p = normPath(filePath);
      const target = join(dirname(p), newName.trim());
      if (target === p) return { ok: true, path: p };
      try {
        if (existsSync(target))
          return { ok: false, error: `${newName.trim()} already exists.` };
        await rename(p, target);
        return { ok: true, path: target };
      } catch (err) {
        return fail(err, "rename");
      }
    },
  );

  ipcMain.handle(
    "files:duplicate",
    async (
      _e,
      filePath: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const p = normPath(filePath);
      try {
        const info = await stat(p);
        const target = uniqueDuplicatePath(p, (c) => existsSync(c));
        if (info.isDirectory()) await cp(p, target, { recursive: true });
        else await copyFile(p, target);
        return { ok: true, path: target };
      } catch (err) {
        return fail(err, "duplicate");
      }
    },
  );

  ipcMain.handle(
    "files:trash",
    async (_e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await shell.trashItem(normPath(filePath));
        return { ok: true };
      } catch (err) {
        return fail(err, "trash");
      }
    },
  );

  ipcMain.handle(
    "files:addToGitignore",
    async (
      _e,
      root: string,
      filePath: string,
    ): Promise<{ ok: boolean; line?: string; error?: string }> => {
      try {
        const r = normPath(root);
        const p = normPath(filePath);
        const info = await stat(p).catch(() => null);
        const line = gitignoreLineFor(r, p, info?.isDirectory() ?? false);
        if (!line) return { ok: false, error: "The file is outside this workspace." };
        const ignoreFile = join(r, ".gitignore");
        const current = existsSync(ignoreFile)
          ? await readFile(ignoreFile, "utf-8")
          : "";
        const next = appendIgnoreLine(current, line);
        if (next !== null) await writeFile(ignoreFile, next, "utf-8");
        return { ok: true, line };
      } catch (err) {
        return fail(err, "gitignore");
      }
    },
  );

  ipcMain.handle("files:reveal", (_e, filePath: string): void => {
    shell.showItemInFolder(normPath(filePath));
  });

  // Paste of the in-app file clipboard (Cut = move, Copy = copy). One
  // handler, because the two differ only in whether the source survives.
  ipcMain.handle(
    "files:pasteInto",
    async (
      _e,
      targetDir: string,
      sourcePath: string,
      cut: boolean,
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const dir = normPath(targetDir);
      const src = normPath(sourcePath);
      try {
        const info = await stat(src);
        if (info.isDirectory() && isPathInside(src, dir))
          return { ok: false, error: "Cannot paste a folder into itself." };
        const target = pasteTargetPath(dir, src, (c) => existsSync(c));
        if (cut) {
          // A cut that lands where it started is a no-op, not an error.
          if (target === src) return { ok: true, path: src };
          try {
            await rename(src, target);
          } catch (err) {
            // Across volumes rename refuses; fall back to copy + delete.
            if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
            if (info.isDirectory()) await cp(src, target, { recursive: true });
            else await copyFile(src, target);
            await rm(src, { recursive: true, force: true });
          }
        } else if (info.isDirectory()) await cp(src, target, { recursive: true });
        else await copyFile(src, target);
        return { ok: true, path: target };
      } catch (err) {
        return fail(err, "paste");
      }
    },
  );
}

/**
 * Artifacts IPC — attachments saved to disk, per session.
 *
 * The composer used to hold attachment previews only in renderer memory, so
 * switching chats lost them. Now every binary attachment is written to
 *   <dataDir>/artifacts/<sessionId>/<timestamp>-<name>
 * and messages persist the file path; thumbnails are re-read on demand.
 */

import { app, ipcMain, shell, dialog, BrowserWindow } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, basename, resolve } from "path";
import { getDataDir, getDataSubdir } from "../data-dir.js";
import { sessionSlug } from "../agent/checkpoint-store.js";

function artifactsRoot(): string {
  const dir = getDataSubdir("artifacts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactSessionDir(sessionId: string): string {
  const dir = join(artifactsRoot(), sessionSlug(sessionId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
const sessionDir = artifactSessionDir;

/** Save arbitrary bytes as a session artifact; returns the file path. */
export function saveArtifactBuffer(
  sessionId: string,
  name: string,
  bytes: Uint8Array,
): string {
  const safeName = basename(name).replace(/[<>:"/\\|?*]/g, "_") || "file";
  const file = join(sessionDir(sessionId), `${Date.now()}-${safeName}`);
  writeFileSync(file, Buffer.from(bytes));
  return file;
}

/** Only paths inside the artifacts folder are ever read back. */
export function artifactReference(path: string): string {
  const root = resolve(getDataSubdir("artifacts"));
  const absolute = resolve(path);
  if (!absolute.startsWith(root)) throw new Error("artifact outside data folder");
  return absolute.slice(resolve(getDataDir()).length + 1).replace(/\\/g, "/");
}

export function resolveArtifactReference(reference: string): string {
  const root = resolve(getDataDir());
  const path = resolve(root, reference.replace(/^file:\/\//i, ""));
  if (!path.startsWith(root)) throw new Error("artifact outside data folder");
  return path;
}

function artifactAbsolute(path: string): string {
  const absolute = resolveArtifactReference(path);
  if (!insideArtifacts(absolute)) throw new Error("outside artifacts dir");
  return absolute;
}

function insideArtifacts(path: string): boolean {
  const root = resolve(artifactsRoot());
  return resolve(path).startsWith(root);
}

export function registerArtifactsIPC(): void {
  ipcMain.handle(
    "artifacts:save",
    (
      _e,
      payload: { sessionId: string; name: string; dataBase64: string },
    ): { ok: boolean; path?: string; error?: string } => {
      try {
        const safeName =
          basename(payload.name).replace(/[<>:"/\\|?*]/g, "_") || "file";
        const file = join(
          sessionDir(payload.sessionId),
          `${Date.now()}-${safeName}`,
        );
        writeFileSync(file, Buffer.from(payload.dataBase64, "base64"));
        return { ok: true, path: file };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save failed",
        };
      }
    },
  );

  // Re-read an image artifact as a data URL (thumbnails after reload).
  ipcMain.handle(
    "artifacts:readImage",
    (
      _e,
      path: string,
      mediaType?: string,
    ): { ok: boolean; dataUrl?: string; error?: string } => {
      try {
        const absolute = artifactAbsolute(path);
        const buf = readFileSync(absolute);
        if (buf.length > 15 * 1024 * 1024)
          return { ok: false, error: "too large" };
        return {
          ok: true,
          dataUrl: `data:${mediaType || "image/png"};base64,${buf.toString("base64")}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "read failed",
        };
      }
    },
  );

  // Open an artifact with the OS default app.
  ipcMain.handle("artifacts:open", (_e, path: string): { ok: boolean } => {
    try {
      void shell.openPath(artifactAbsolute(path));
    } catch {
      return { ok: false };
    }
    return { ok: true };
  });

  // Raw bytes (base64) for document previews (pdf/docx/xlsx) in the viewer.
  ipcMain.handle(
    "artifacts:readBytes",
    (
      _e,
      path: string,
    ): { ok: boolean; base64?: string; error?: string } => {
      try {
        const absolute = artifactAbsolute(path);
        const buf = readFileSync(absolute);
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

  // Read a text/code artifact for the in-app viewer.
  ipcMain.handle(
    "artifacts:readText",
    (_e, path: string): { ok: boolean; content?: string; error?: string } => {
      try {
        const absolute = artifactAbsolute(path);
        const buf = readFileSync(absolute);
        if (buf.length > 2 * 1024 * 1024)
          return { ok: false, error: "File is too large to preview" };
        if (buf.includes(0)) return { ok: false, error: "Binary file" };
        return { ok: true, content: buf.toString("utf-8") };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "read failed",
        };
      }
    },
  );

  // Save-as: copy an artifact to a user-chosen location.
  ipcMain.handle(
    "artifacts:download",
    async (
      _e,
      path: string,
      name?: string,
    ): Promise<{ ok: boolean; savedTo?: string; error?: string }> => {
      try {
        const absolute = artifactAbsolute(path);
        if (!existsSync(absolute)) return { ok: false, error: "not found" };
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        const res = await dialog.showSaveDialog(win!, {
          defaultPath: name || basename(absolute).replace(/^\d+-/, ""),
        });
        if (res.canceled || !res.filePath) return { ok: false };
        copyFileSync(absolute, res.filePath);
        return { ok: true, savedTo: res.filePath };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "download failed",
        };
      }
    },
  );

  // Save-all: copy every listed artifact into one user-chosen folder.
  ipcMain.handle(
    "artifacts:downloadAll",
    async (
      _e,
      items: { path: string; name?: string }[],
    ): Promise<{
      ok: boolean;
      savedTo?: string;
      saved?: number;
      error?: string;
    }> => {
      try {
        if (!items?.length) return { ok: false, error: "nothing to save" };
        const win = BrowserWindow.getFocusedWindow() ?? undefined;
        const res = await dialog.showOpenDialog(win!, {
          title: "Save all files to…",
          properties: ["openDirectory", "createDirectory"],
          buttonLabel: "Save here",
        });
        if (res.canceled || !res.filePaths[0]) return { ok: false };
        const dir = res.filePaths[0];

        let saved = 0;
        // Two files can share a name (the same chart written twice, or an
        // attachment and an output). Overwriting silently would lose one, so
        // later duplicates get " (2)" the way a browser download does.
        const used = new Set<string>();
        for (const item of items) {
          const absolute = artifactAbsolute(item.path);
          if (!existsSync(absolute)) continue;
          const wanted =
            basename(item.name || absolute).replace(/[<>:"/\\|?*]/g, "_") ||
            "file";
          const dot = wanted.lastIndexOf(".");
          const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
          const ext = dot > 0 ? wanted.slice(dot) : "";
          let final = wanted;
          for (let n = 2; used.has(final.toLowerCase()); n++)
            final = `${stem} (${n})${ext}`;
          used.add(final.toLowerCase());
          copyFileSync(absolute, join(dir, final));
          saved++;
        }
        return { ok: true, savedTo: dir, saved };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save failed",
        };
      }
    },
  );

  // The OS icon of whatever app owns this file type — the small Acrobat/Word/
  // editor badge shown on a file card. Cached per extension: getFileIcon hits
  // the shell icon cache and a chat can hold dozens of files.
  const iconCache = new Map<string, string | null>();
  ipcMain.handle(
    "artifacts:appIcon",
    async (_e, path: string): Promise<{ ok: boolean; dataUrl?: string }> => {
      try {
        const absolute = artifactAbsolute(path);
        const ext = (basename(absolute).split(".").pop() || "").toLowerCase();
        const key = ext || "_none";
        if (iconCache.has(key)) {
          const hit = iconCache.get(key);
          return hit ? { ok: true, dataUrl: hit } : { ok: false };
        }
        if (!existsSync(absolute)) return { ok: false };
        // "normal" is 32px on Windows/macOS — drawn at 16 CSS px it stays
        // sharp on a HiDPI display, where the 16px "small" icon blurs.
        const icon = await app.getFileIcon(absolute, { size: "normal" });
        const dataUrl = icon.isEmpty() ? null : icon.toDataURL();
        iconCache.set(key, dataUrl);
        return dataUrl ? { ok: true, dataUrl } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  );
}

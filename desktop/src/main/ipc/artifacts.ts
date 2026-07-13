/**
 * Artifacts IPC — attachments saved to disk, per session.
 *
 * The composer used to hold attachment previews only in renderer memory, so
 * switching chats lost them. Now every binary attachment is written to
 *   <dataDir>/artifacts/<sessionId>/<timestamp>-<name>
 * and messages persist the file path; thumbnails are re-read on demand.
 */

import { ipcMain, shell, dialog, BrowserWindow } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, basename, resolve } from "path";
import { getDataDir, getDataSubdir } from "../data-dir.js";

function artifactsRoot(): string {
  const dir = getDataSubdir("artifacts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactSessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const dir = join(artifactsRoot(), safe);
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
}

/**
 * Artifacts IPC — attachments saved to disk, per session.
 *
 * The composer used to hold attachment previews only in renderer memory, so
 * switching chats lost them. Now every binary attachment is written to
 *   <dataDir>/artifacts/<sessionId>/<timestamp>-<name>
 * and messages persist the file path; thumbnails are re-read on demand.
 */

import { ipcMain, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename, resolve } from "path";
import { getDataSubdir } from "../data-dir.js";

function artifactsRoot(): string {
  const dir = getDataSubdir("artifacts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const dir = join(artifactsRoot(), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Only paths inside the artifacts folder are ever read back. */
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
        if (!insideArtifacts(path))
          return { ok: false, error: "outside artifacts dir" };
        const buf = readFileSync(path);
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
    if (insideArtifacts(path)) void shell.openPath(path);
    return { ok: true };
  });
}

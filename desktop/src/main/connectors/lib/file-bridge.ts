/**
 * FileBridge — how connectors touch the chat's files, and the ONLY way they
 * may. One object per call, resolved from (sessionId, space):
 *
 *   Home → the chat's sandbox dir. Connectors are a bridge across Home's
 *          isolation, not an escape hatch: reads AND writes are confined to
 *          the sandbox root (generalizing what Telegram's sendFile proved).
 *   Code → the run's own working directory (the per-run AsyncLocalStorage
 *          cwd), so parallel chats download into their own folders. Reads may
 *          name any absolute path — the agent already has full fs there.
 *
 * Every write returns an `[artifact]` marker line; surfacing it in the tool
 * output is what makes downloads appear as file chips/thumbnails in the chat
 * and in the Files panel — zero renderer work per connector.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
} from "fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { sandboxWorkDir } from "../../sandbox/podman-engine.js";
import { getCwd } from "../../engine/utils/cwd.js";

/** Refuse to write files past this — a connector download is chat material,
 * not a backup channel. Per-call override for known-bigger media. */
const MAX_WRITE_BYTES = 100 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function mimeOf(name: string): string {
  return EXT_MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export interface FileBridge {
  space: "home" | "code";
  root: string;
  /** Absolute path for reading/uploading `path`, or throw with the fix. */
  resolveRead(path: string): string;
  /** Write `data` under a collision-safe version of `name`; returns the path
   * and the `[artifact]` line to include in the tool output. */
  write(
    name: string,
    data: Buffer | Readable,
    opts?: { maxBytes?: number },
  ): Promise<{ path: string; artifactLine: string }>;
}

/** A name that doesn't collide in dir: "report.pdf" → "report (2).pdf". */
function freeName(dir: string, name: string): string {
  const clean = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "file";
  if (!existsSync(join(dir, clean))) return clean;
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

export function makeFileBridge(
  sessionId: string,
  space?: string,
): FileBridge {
  const home = space === "home";
  const root = home
    ? resolve(sandboxWorkDir(sessionId || "default"))
    : resolve(getCwd());

  const confine = (p: string): string => {
    const full = isAbsolute(p) ? resolve(p) : resolve(root, p);
    // `${root}${sep}` on purpose: startsWith(root) alone would also accept a
    // sibling directory whose name merely begins with the root's.
    if (full !== root && !full.startsWith(root + sep))
      throw new Error(
        home
          ? `In Home, connector files must stay inside this chat's sandbox. “${p}” is outside it.`
          : `“${p}” is outside this chat's working folder (${root}).`,
      );
    return full;
  };

  return {
    space: home ? "home" : "code",
    root,

    resolveRead(p: string): string {
      // Home: everything confined. Code: absolute paths pass as-is (the agent
      // already reads the whole disk there); relative resolve against cwd.
      const full = home
        ? confine(p)
        : isAbsolute(p)
          ? resolve(p)
          : resolve(root, p);
      if (!existsSync(full))
        throw new Error(
          home
            ? `No such file in the sandbox: ${p}`
            : `No such file: ${full}`,
        );
      const st = statSync(full);
      if (!st.isFile()) throw new Error(`Not a file: ${p}`);
      return full;
    },

    async write(name, data, opts) {
      const cap = opts?.maxBytes ?? MAX_WRITE_BYTES;
      mkdirSync(root, { recursive: true });
      const finalName = freeName(root, name);
      const full = join(root, finalName);

      if (Buffer.isBuffer(data)) {
        if (data.length > cap)
          throw new Error(
            `File too large (${Math.round(data.length / 1e6)}MB > ${Math.round(cap / 1e6)}MB cap).`,
          );
        const { writeFile } = await import("fs/promises");
        await writeFile(full, data);
      } else {
        // Stream with a running count so an oversized body aborts mid-flight
        // instead of filling the disk first and checking after.
        let written = 0;
        const counted = data;
        counted.on("data", (chunk: Buffer) => {
          written += chunk.length;
          if (written > cap)
            counted.destroy(
              new Error(
                `File too large (over ${Math.round(cap / 1e6)}MB cap).`,
              ),
            );
        });
        await pipeline(counted, createWriteStream(full));
      }
      return {
        path: full,
        artifactLine: `[artifact] ${mimeOf(finalName)} ${finalName} :: ${full}`,
      };
    },
  };
}
// MARKER-TEST

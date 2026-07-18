/**
 * Host-side view of a chat's sandbox files.
 *
 * The backing store is the chat's real working directory
 * (sandboxWorkDir = <dataDir>/sandboxes/<id>) — the SAME tree Podman mounts at
 * /work, the subprocess engine uses as cwd, and (since subdir support) the
 * Pyodide engine seeds from and writes back to. It is a real directory tree, so
 * files live at their relative paths (subfolders included). SandboxList/Read/
 * Write and RunPython therefore all see one coherent, nested directory.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "path";
import { saveArtifactBuffer } from "../ipc/artifacts.js";
import { mirrorToPyodideSession } from "./pyodide-engine.js";
import { sandboxWorkDir } from "./podman-engine.js";
import { mediaTypeOf } from "./index.js";

export interface SandboxFileInfo {
  /** POSIX relative path within the sandbox (e.g. "scripts/build.py"). */
  name: string;
  size: number;
  mtimeMs: number;
  path: string;
}

/** POSIX-normalize a relative path for display / cross-platform matching. */
function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

/**
 * Resolve a sandbox-relative path to an absolute path INSIDE the work dir.
 * Rejects absolute paths and any traversal that escapes the sandbox.
 */
function resolveInWorkDir(sessionId: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null;
  const root = sandboxWorkDir(sessionId);
  const abs = normalize(join(root, rel));
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function walk(dir: string, root: string, out: SandboxFileInfo[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, root, out);
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      name: toPosix(relative(root, full)),
      size: st.size,
      mtimeMs: st.mtimeMs,
      path: full,
    });
  }
}

export function listSandboxFiles(sessionId: string): SandboxFileInfo[] {
  const root = sandboxWorkDir(sessionId);
  const out: SandboxFileInfo[] = [];
  walk(root, root, out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSandboxFile(
  sessionId: string,
  name: string,
): { ok: boolean; content?: string; error?: string } {
  const abs = resolveInWorkDir(sessionId, name);
  if (!abs)
    return {
      ok: false,
      error: `Invalid path "${name}" — use a sandbox-relative path (no "..", no absolute paths).`,
    };
  let st;
  try {
    st = statSync(abs);
  } catch {
    return {
      ok: false,
      error: `No file named "${name}" in this chat's sandbox. Use SandboxList to see what exists.`,
    };
  }
  if (!st.isFile())
    return { ok: false, error: `"${name}" is a directory, not a file.` };
  if (st.size > 400_000)
    return { ok: false, error: "File is too large to read as text (400KB limit)." };
  const buf = readFileSync(abs);
  if (buf.includes(0))
    return {
      ok: false,
      error: "Binary file — process it with RunPython instead.",
    };
  return { ok: true, content: buf.toString("utf-8") };
}

export function editSandboxFile(
  sessionId: string,
  name: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { ok: boolean; content?: string; error?: string } {
  const abs = resolveInWorkDir(sessionId, name);
  if (!abs)
    return {
      ok: false,
      error: `Invalid path "${name}" — use a sandbox-relative path (no "..", no absolute paths).`,
    };
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { ok: false, error: `No file named "${name}" in this chat's sandbox. Use SandboxList to see what exists.` };
  }
  if (buf.includes(0))
    return { ok: false, error: "Binary file — edit with RunPython instead." };
  const file = buf.toString("utf-8");
  if (oldString === newString)
    return { ok: false, error: "old_string and new_string are identical — nothing to change." };
  if (!file.includes(oldString))
    return { ok: false, error: `String to replace not found in "${name}".` };
  const matches = file.split(oldString).length - 1;
  if (matches > 1 && !replaceAll)
    return {
      ok: false,
      error: `Found ${matches} matches of old_string in "${name}". Set replace_all=true to replace all, or provide more context to uniquely identify the instance.`,
    };
  const updated = replaceAll
    ? file.split(oldString).join(newString)
    : file.replace(oldString, newString);
  writeFileSync(abs, Buffer.from(updated, "utf-8"));
  mirrorToPyodideSession(sessionId, toPosix(name), Buffer.from(updated, "utf-8"));
  return { ok: true, content: updated };
}

export function writeSandboxFile(
  sessionId: string,
  name: string,
  content: string,
): { path: string; mediaType: string } {
  const abs = resolveInWorkDir(sessionId, name);
  if (!abs)
    throw new Error(
      `Invalid path "${name}" — use a sandbox-relative path (no "..", no absolute paths).`,
    );
  const bytes = Buffer.from(content, "utf-8");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  // Keep the live Python sandbox in sync so RunPython sees the file at once.
  mirrorToPyodideSession(sessionId, toPosix(name), bytes);
  // Also register an artifact (flat, by basename) so the write shows up as a
  // chat attachment / preview — the canonical copy lives in the work dir above.
  const path = saveArtifactBuffer(sessionId, name, bytes);
  return { path, mediaType: mediaTypeOf(name) };
}

/**
 * Drop an arbitrary file (any bytes, e.g. a skill's bundled resource) into the
 * chat sandbox at a relative path, preserving subfolders. Written to the work
 * dir on disk AND mirrored into the live Pyodide FS, so both SandboxRead and
 * RunPython see it. Returns the stored absolute path (or null if the path is
 * invalid / escapes the sandbox).
 */
export function copyBufferIntoSandbox(
  sessionId: string,
  name: string,
  bytes: Buffer,
): string | null {
  const abs = resolveInWorkDir(sessionId, name);
  if (!abs) return null;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  mirrorToPyodideSession(sessionId, toPosix(name), bytes);
  return abs;
}

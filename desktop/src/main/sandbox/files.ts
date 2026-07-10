/**
 * Host-side view of a chat's sandbox files.
 *
 * The backing store is the chat's artifacts dir (files are saved as
 * "<timestamp>-<name>"); the LOGICAL file set is newest-per-name — the same
 * rule the Pyodide seeder uses, so SandboxRead/Write and RunPython see one
 * coherent directory.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { artifactSessionDir, saveArtifactBuffer } from "../ipc/artifacts.js";
import { mirrorToPyodideSession } from "./pyodide-engine.js";
import { mediaTypeOf } from "./index.js";

export interface SandboxFileInfo {
  name: string;
  size: number;
  mtimeMs: number;
  path: string;
}

export function listSandboxFiles(sessionId: string): SandboxFileInfo[] {
  const dir = artifactSessionDir(sessionId);
  const newest = new Map<string, SandboxFileInfo & { ts: number }>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of entries) {
    const full = join(dir, f);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const m = /^(\d+)-(.+)$/.exec(f);
    const name = m ? m[2] : f;
    const ts = m ? Number(m[1]) : st.mtimeMs;
    const cur = newest.get(name);
    if (!cur || ts > cur.ts)
      newest.set(name, { name, size: st.size, mtimeMs: st.mtimeMs, path: full, ts });
  }
  return [...newest.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ ts: _ts, ...rest }) => rest);
}

export function readSandboxFile(
  sessionId: string,
  name: string,
): { ok: boolean; content?: string; error?: string } {
  const hit = listSandboxFiles(sessionId).find((f) => f.name === name);
  if (!hit)
    return {
      ok: false,
      error: `No file named "${name}" in this chat's sandbox. Use SandboxList to see what exists.`,
    };
  if (hit.size > 400_000)
    return { ok: false, error: "File is too large to read as text (400KB limit)." };
  const buf = readFileSync(hit.path);
  if (buf.includes(0))
    return {
      ok: false,
      error: "Binary file — process it with RunPython instead.",
    };
  return { ok: true, content: buf.toString("utf-8") };
}

export function writeSandboxFile(
  sessionId: string,
  name: string,
  content: string,
): { path: string; mediaType: string } {
  const bytes = Buffer.from(content, "utf-8");
  const path = saveArtifactBuffer(sessionId, name, bytes);
  // Keep the live Python sandbox in sync so RunPython sees the file at once.
  mirrorToPyodideSession(sessionId, name, bytes);
  return { path, mediaType: mediaTypeOf(name) };
}

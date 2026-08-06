/**
 * "That file" — resolved the same way in Home and in Code.
 *
 * The two spaces hold files in different places, and the model should not
 * have to know which one it is in to put a picture in the vault:
 *
 *   Home  — the chat's sandbox (what RunPython wrote, what the user dropped
 *           into the chat's folder);
 *   Code  — the workspace on disk;
 *   both  — artifacts, which is where a file ATTACHED TO A MESSAGE lands,
 *           and where screenshots and generated documents are kept.
 *
 * So a source is a name or a path, and this tries the plausible readings in
 * a fixed order, reporting which one won. The order matters: an absolute
 * path is unambiguous and goes first; the chat's own sandbox outranks the
 * workspace, because in Home there is no workspace and in Code a bare name
 * far more often means "the file we were just working with".
 *
 * Nothing here writes. It answers "where is that, actually".
 */

import { existsSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { getDataSubdir } from "../data-dir.js";
import { resolveSandboxPath } from "../sandbox/files.js";
import { getWorkspacePath } from "../ipc/workspace.js";

export type SourceOrigin = "absolute" | "sandbox" | "workspace" | "artifact";

export interface ResolvedSource {
  path: string;
  origin: SourceOrigin;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every artifact folder is under <dataDir>/artifacts — a reference may be
 * a full path, or the `artifacts/<session>/<file>` form tool results use. */
function artifactCandidate(ref: string): string | null {
  const root = resolve(getDataSubdir("artifacts"));
  const clean = ref.replace(/^file:\/\//i, "").replace(/\\/g, "/");
  const abs = isAbsolute(clean)
    ? resolve(clean)
    : resolve(root, clean.replace(/^artifacts\//i, ""));
  // Never escape the artifacts root through "..": the tool this feeds copies
  // whatever comes back, and a path traversal here would copy anything.
  return abs.startsWith(root) && isFile(abs) ? abs : null;
}

/**
 * Find the file a source string names.
 *
 * @param source  an absolute path, a sandbox-relative name, a
 *                workspace-relative path, or an artifact reference
 * @param sessionId the chat, for its sandbox
 */
export function resolveSource(
  source: string,
  sessionId?: string,
): ResolvedSource | null {
  const raw = source.trim().replace(/^file:\/\//i, "");
  if (!raw) return null;

  if (isAbsolute(raw) && isFile(raw)) return { path: raw, origin: "absolute" };

  if (sessionId) {
    const inSandbox = resolveSandboxPath(sessionId, raw);
    if (inSandbox && isFile(inSandbox))
      return { path: inSandbox, origin: "sandbox" };
  }

  try {
    const ws = getWorkspacePath();
    if (ws) {
      const abs = resolve(join(ws, raw));
      // Stay inside the workspace — same reason as the artifacts guard.
      if (abs.startsWith(resolve(ws)) && isFile(abs))
        return { path: abs, origin: "workspace" };
    }
  } catch {
    /* no workspace (Home) — the next reading may still find it */
  }

  const artifact = artifactCandidate(raw);
  if (artifact) return { path: artifact, origin: "artifact" };

  return null;
}

/** What the tool tells the model when nothing matched. */
export function sourceHint(sessionId?: string): string {
  const places = [
    sessionId ? "this chat's sandbox (a name like chart.png)" : null,
    "the workspace (a path relative to it, or an absolute one)",
    "an artifact from this chat (the path a tool result gave you)",
  ].filter(Boolean);
  return `Looked in: ${places.join("; ")}.`;
}

/** True when the path exists and is a file — for callers that already know
 * where something is. */
export function fileExists(p: string): boolean {
  return existsSync(p) && isFile(p);
}

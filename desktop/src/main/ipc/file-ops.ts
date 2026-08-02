/**
 * File-management helpers behind the tree's context menu — the pure half.
 *
 * The IPC handlers (files.ts) stay thin; everything with a decision in it
 * lives here where the probe can reach it under plain node: what counts as a
 * legal new name, how a duplicate gets numbered, what line a path earns in
 * .gitignore. A wrong answer here renames the wrong file or ignores the
 * wrong tree — the kind of bug that must not need an app boot to catch.
 */

import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";

/**
 * A name typed into "New File" / "Rename". Subfolders are allowed ("a/b.ts"
 * creates them, like VS Code); escaping the parent is not, and neither are
 * the characters Windows refuses.
 */
export function validateEntryName(name: string): { ok: boolean; error?: string } {
  const n = name.trim();
  if (!n) return { ok: false, error: "Name is empty." };
  if (n.length > 200) return { ok: false, error: "Name is too long." };
  const parts = n.split(/[\\/]/);
  if (parts.some((p) => !p.trim()))
    return { ok: false, error: "Name has an empty path segment." };
  if (parts.some((p) => p === "." || p === ".."))
    return { ok: false, error: "Name cannot navigate with . or .." };
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(n))
    return { ok: false, error: 'Name contains a forbidden character (<>:"|?*).' };
  if (parts.some((p) => /[. ]$/.test(p)))
    return { ok: false, error: "Windows forbids names ending in a dot or space." };
  return { ok: true };
}

/**
 * Where a duplicate lands: "report.md" → "report copy.md" → "report copy 2.md".
 * `exists` is injected so the numbering logic is testable without a disk.
 */
export function uniqueDuplicatePath(
  path: string,
  exists: (candidate: string) => boolean,
): string {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  let candidate = join(dir, `${stem} copy${ext}`);
  for (let i = 2; exists(candidate); i++)
    candidate = join(dir, `${stem} copy ${i}${ext}`);
  return candidate;
}

/**
 * The line a path earns in the workspace .gitignore: relative, forward
 * slashes, rooted with "/" so "build" doesn't swallow "src/build", and a
 * trailing "/" for a directory.
 */
export function gitignoreLineFor(
  root: string,
  targetPath: string,
  isDirectory: boolean,
): string | null {
  const rel = relative(root, targetPath);
  if (!rel || rel.startsWith("..")) return null;
  const posix = rel.split(sep).join("/");
  return `/${posix}${isDirectory ? "/" : ""}`;
}

/**
 * Where a pasted entry lands: keep its own name when the slot is free,
 * otherwise fall into the same "copy / copy 2" numbering a duplicate uses.
 */
export function pasteTargetPath(
  targetDir: string,
  sourcePath: string,
  exists: (candidate: string) => boolean,
): string {
  const direct = join(targetDir, basename(sourcePath));
  return exists(direct) ? uniqueDuplicatePath(direct, exists) : direct;
}

/** True when `child` is `parent` itself or sits anywhere under it — the guard
 * that keeps a folder from being pasted into its own subtree. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Append a line to .gitignore content, once, keeping the file newline-clean. */
export function appendIgnoreLine(current: string, line: string): string | null {
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(line)) return null; // already ignored — nothing to write
  const body = current.replace(/\s+$/, "");
  return body ? `${body}\n${line}\n` : `${line}\n`;
}

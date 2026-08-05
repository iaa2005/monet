/**
 * Finding a file by name, from a root.
 *
 * The tree is lazy — a folder's children only exist once you expand it — so
 * filtering what is on screen would search a handful of loaded nodes and
 * confidently report nothing for the rest of the project. A search box that
 * answers "no matches" when the file is one collapsed folder away is worse
 * than no search box, so this walks the real directory instead.
 *
 * Breadth-first on purpose: `src/App.tsx` should beat
 * `node_modules/.cache/…/App.tsx` for the query "app", and depth-first would
 * disappear into the first subtree it found.
 */

import { readdir } from "fs/promises";
import { join } from "path";

export interface SearchHit {
  name: string;
  path: string;
  isDirectory: boolean;
  /** Path relative to the search root, shown instead of the absolute one. */
  rel: string;
}

/**
 * Directories never worth walking. Not a matter of taste: node_modules alone
 * can hold more entries than the rest of the project by two orders of
 * magnitude, and every hit in it is noise.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
]);

/**
 * Whether to walk into a directory.
 *
 * SKIP_DIRS is unconditional — `.git` and `node_modules` are noise whatever
 * the user asked to see. Dot-directories are otherwise skipped only while the
 * tree is hiding them: searching a folder whose results you cannot then find
 * in the tree is worse than not searching it.
 */
export function skipDir(name: string, includeHidden = false): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return !includeHidden && name.startsWith(".");
}

export interface SearchOptions {
  /** Stop after this many hits. The list is for picking from, not reading. */
  limit?: number;
  /** Stop after this long. A network share can make one readdir take seconds,
   * and a search that never returns looks like a hang. */
  budgetMs?: number;
  /** How deep to descend. Deep enough for a real project, shallow enough that
   * a pathological tree cannot run us out of time on its own. */
  maxDepth?: number;
  /** Match dot-files and descend into dot-folders — set when the tree is
   * showing them, so search and tree agree about what exists. */
  includeHidden?: boolean;
}

/**
 * Case-insensitive substring match on the name, breadth-first from `root`.
 *
 * Returns fewer results than exist when a limit or the time budget is hit —
 * the caller says so rather than pretending the list is complete.
 */
export async function searchFiles(
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], truncated: false };

  const limit = opts.limit ?? 200;
  const budgetMs = opts.budgetMs ?? 3000;
  const maxDepth = opts.maxDepth ?? 12;
  const includeHidden = opts.includeHidden === true;
  const deadline = Date.now() + budgetMs;

  const hits: SearchHit[] = [];
  let truncated = false;
  let queue: { dir: string; rel: string; depth: number }[] = [
    { dir: root, rel: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const { dir, rel, depth } of queue) {
      if (hits.length >= limit || Date.now() > deadline) {
        truncated = true;
        return { hits, truncated };
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip it, don't fail the search
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const isDir = e.isDirectory();
        // A hidden entry is a hit only when the tree would show it.
        const visible = includeHidden || !e.name.startsWith(".");
        if (visible && e.name.toLowerCase().includes(q)) {
          if (hits.length >= limit) {
            truncated = true;
            return { hits, truncated };
          }
          hits.push({
            name: e.name,
            path: join(dir, e.name),
            isDirectory: isDir,
            rel: childRel,
          });
        }
        // A skipped folder is skipped for descending, but its own name can
        // still match — the check above already ran.
        if (isDir && !skipDir(e.name, includeHidden) && depth + 1 <= maxDepth) {
          next.push({ dir: join(dir, e.name), rel: childRel, depth: depth + 1 });
        }
      }
    }
    queue = next;
  }

  return { hits, truncated };
}

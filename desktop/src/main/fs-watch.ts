/**
 * Telling the renderer that the workspace changed on disk.
 *
 * The file tree used to load once and then stay as it was: the agent could
 * create ten files and the panel showed the folder as it looked when you opened
 * it. Reloading on a timer would fight the user's expanded folders, so this
 * reports the fact and lets the tree decide.
 *
 * One recursive watch on the workspace root. Windows serves that from a single
 * ReadDirectoryChangesW, so the cost is in the event volume, not the watch —
 * hence the ignore list and the debounce, both of which run before anything
 * crosses to the renderer.
 */

import { watch, type FSWatcher } from "fs";
import { BrowserWindow } from "electron";

/** Paths whose churn is never worth a redraw. Matched per segment, so
 * `src/node_modules/x` is caught as surely as `node_modules/x`. */
const NOISE = new Set([
  "node_modules",
  ".git",
  ".monet",
  ".monet-prod",
  "dist",
  "out",
  "target",
  "__pycache__",
  ".next",
  ".cache",
]);

/**
 * True when a change at this path should not reach the renderer.
 *
 * Exported for the probe: the whole value of the watcher is that it stays quiet
 * during a build, and that is a property of this function alone.
 */
export function isNoise(relPath: string): boolean {
  if (!relPath) return true;
  for (const seg of relPath.split(/[\\/]/)) {
    if (!seg) continue;
    if (NOISE.has(seg)) return true;
    // Editors write `.foo.swp`, `4913`, `.#lock` next to the real file; the
    // tree hides dot-entries anyway, so a redraw for one shows nothing new.
    if (seg.startsWith(".")) return true;
  }
  return false;
}

let watcher: FSWatcher | null = null;
let watched = "";
let timer: NodeJS.Timeout | null = null;

function announce(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("files:changed");
  }
}

/**
 * Watch `root`, replacing any previous watch. A repeat call for the same folder
 * is a no-op, so the per-run workspace pin can call it freely.
 */
export function watchWorkspace(root: string): void {
  if (root === watched && watcher) return;
  stopWatchingWorkspace();
  if (!root) return;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_e, name) => {
      if (typeof name === "string" && isNoise(name)) return;
      // Coalesce: `npm install` or a multi-file edit is one redraw, not
      // thousands. Trailing edge, so the burst has finished when it fires.
      if (timer) clearTimeout(timer);
      timer = setTimeout(announce, 400);
    });
    watched = root;
    // A watch on a vanished or unreadable folder emits an error rather than
    // throwing at setup; dropping it keeps the tree on its last good state.
    watcher.on("error", () => stopWatchingWorkspace());
  } catch {
    // Network shares and some virtual filesystems refuse recursive watches.
    // Losing live refresh is a downgrade, not a failure — the tree still
    // reloads when the folder changes or the panel reopens.
    watcher = null;
    watched = "";
  }
}

export function stopWatchingWorkspace(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* already gone */
    }
    watcher = null;
  }
  watched = "";
}

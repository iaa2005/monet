/**
 * Bookmarks and visit history — the disk half.
 *
 * Two small JSON files in the app's data dir, global rather than per project:
 * a bookmark is "my dev server, my docs", and those follow the user, not the
 * folder. The rules (dedup keys, caps, what is recordable) live in
 * bookmark-store.ts where a probe can hold them.
 *
 * Every change is broadcast as `browser:bookmarksChanged`, the same pattern
 * the dev-server list uses: the empty tab and the toolbar star both redraw on
 * the event instead of polling, and a second window stays honest for free.
 */

import { BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import {
  isBookmarked,
  pushVisit,
  retitleVisit,
  toggleBookmark,
  type Bookmark,
  type Visit,
} from "./bookmark-store.js";

const bookmarksFile = (): string => join(getDataDir(), "browser-bookmarks.json");
const historyFile = (): string => join(getDataDir(), "browser-history.json");

function readList<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send("browser:bookmarksChanged");
}

// ── Bookmarks ─────────────────────────────────────────────────────────

export function listBookmarks(): Bookmark[] {
  return readList<Bookmark>(bookmarksFile());
}

export function togglePageBookmark(
  url: string,
  title: string,
): { bookmarked: boolean } {
  const r = toggleBookmark(listBookmarks(), { url, title });
  writeFileSync(bookmarksFile(), JSON.stringify(r.list, null, 2));
  broadcast();
  return { bookmarked: r.bookmarked };
}

export function removeBookmark(id: string): void {
  const next = listBookmarks().filter((b) => b.id !== id);
  writeFileSync(bookmarksFile(), JSON.stringify(next, null, 2));
  broadcast();
}

export function pageIsBookmarked(url: string): boolean {
  return isBookmarked(listBookmarks(), url);
}

// ── Visit history ─────────────────────────────────────────────────────

/**
 * In memory between flushes: a SPA fires a navigation per route change, and a
 * write per keystroke-sized event is noise the log does not need. Half a
 * second of latency on "recent" is invisible; the file staying small is not.
 */
let log: Visit[] | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function loadedLog(): Visit[] {
  if (log === null) log = readList<Visit>(historyFile());
  return log;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      writeFileSync(historyFile(), JSON.stringify(log ?? [], null, 2));
    } catch {
      /* a lost visit log entry is not worth surfacing */
    }
    broadcast();
  }, 500);
}

export function recordVisit(url: string): void {
  const next = pushVisit(loadedLog(), { url, title: "", at: Date.now() });
  if (next !== log) {
    log = next;
    scheduleFlush();
  }
}

export function recordTitle(url: string, title: string): void {
  log = retitleVisit(loadedLog(), url, title);
  scheduleFlush();
}

export function recentVisits(limit = 20): Visit[] {
  return loadedLog().slice(0, limit);
}

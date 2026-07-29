/**
 * Workspace IPC handler — get/set working directory.
 * Reloads CLAUDE.md on change, updates window title. The last chosen folder is
 * persisted and restored on launch — in a PACKAGED app process.cwd() is the
 * install dir (win-unpacked/…), never a sane workspace, and every tool that
 * relies on getWorkspacePath()/cwd would otherwise search there.
 */

import { app, ipcMain, BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { loadClaudeMd } from "../claude-md.js";
import { getDataDir } from "../data-dir.js";

let workspacePath = process.cwd();
let claudeMdContent: string | null = null;

const stateFile = (): string => join(getDataDir(), "workspace.json");

function loadSavedWorkspace(): string | null {
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf-8")) as {
      path?: string;
    };
    return typeof j.path === "string" && existsSync(j.path) ? j.path : null;
  } catch {
    return null;
  }
}

function saveWorkspace(path: string): void {
  try {
    writeFileSync(stateFile(), JSON.stringify({ path }, null, 2));
  } catch {
    /* best-effort */
  }
}

/** Apply a directory as the effective workspace (state + process cwd). */
function applyWorkspace(path: string): void {
  workspacePath = path;
  try {
    process.chdir(path);
  } catch {
    /* directory may be unreadable — keep state anyway */
  }
}

export function registerWorkspaceIPC(): void {
  // Restore the last chosen folder; a packaged first run falls back to the
  // user's home dir instead of the install dir.
  const saved = loadSavedWorkspace();
  if (saved) applyWorkspace(saved);
  else if (app.isPackaged) applyWorkspace(app.getPath("home"));

  // Load initial CLAUDE.md
  claudeMdContent = loadClaudeMd(workspacePath);

  ipcMain.handle("workspace:get", () => workspacePath);

  ipcMain.handle("workspace:set", (_event, path: string) => {
    if (!existsSync(path)) {
      // Reported, not thrown. Most calls here are the automatic restore of a
      // chat's saved folder, and a folder that has moved is an ordinary state,
      // not a fault: the project gets relocated, a share is offline, a drive
      // is unplugged. Throwing logged "Error occurred in handler for
      // 'workspace:set'" with a stack on every such chat open — noise that
      // reads like a crash while the renderer was already handling it fine.
      return { ok: false, path, error: `Directory not found: ${path}` };
    }
    applyWorkspace(path);
    saveWorkspace(path);

    // Reload CLAUDE.md
    claudeMdContent = loadClaudeMd(path);

    // Update window title
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.setTitle(`Code Monet — ${basename(path)}`);
    }

    return { ok: true, path, claudeMd: claudeMdContent };
  });

  ipcMain.handle("workspace:getClaudeMd", () => claudeMdContent);
}

/**
 * Make `path` the effective workspace for an incoming run: updates the global
 * cwd state and reloads CLAUDE.md so the agent's prompt and tools resolve
 * against THIS chat's folder. Unlike the workspace:set IPC it does NOT persist
 * the folder as the user's saved default or retitle the window — it's the
 * per-chat pin the send path applies before running, since the renderer's
 * restore-on-open is async and can lose the race. No-op when the path is
 * empty, already current, or gone.
 */
export function applyWorkspaceForRun(path: string): void {
  if (!path || path === workspacePath || !existsSync(path)) return;
  applyWorkspace(path);
  claudeMdContent = loadClaudeMd(path);
}

export function getWorkspacePath(): string {
  return workspacePath;
}

export function getClaudeMdContent(): string | null {
  return claudeMdContent;
}

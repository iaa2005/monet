/**
 * Workspace IPC handler — get/set working directory.
 * Reloads CLAUDE.md on change, updates window title.
 */

import { ipcMain, BrowserWindow } from "electron";
import { existsSync } from "fs";
import { basename } from "path";
import { loadClaudeMd } from "../claude-md.js";

let workspacePath = process.cwd();
let claudeMdContent: string | null = null;

export function registerWorkspaceIPC(): void {
  // Load initial CLAUDE.md
  claudeMdContent = loadClaudeMd(workspacePath);

  ipcMain.handle("workspace:get", () => workspacePath);

  ipcMain.handle("workspace:set", (_event, path: string) => {
    if (!existsSync(path)) {
      throw new Error(`Directory not found: ${path}`);
    }
    workspacePath = path;
    process.chdir(path);

    // Reload CLAUDE.md
    claudeMdContent = loadClaudeMd(path);

    // Update window title
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.setTitle(`Claude Code Desktop — ${basename(path)}`);
    }

    return { ok: true, path, claudeMd: claudeMdContent };
  });

  ipcMain.handle("workspace:getClaudeMd", () => claudeMdContent);
}

export function getWorkspacePath(): string {
  return workspacePath;
}

export function getClaudeMdContent(): string | null {
  return claudeMdContent;
}

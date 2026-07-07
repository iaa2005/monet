/**
 * Workspace IPC handler — get/set working directory.
 */

import { ipcMain } from 'electron'
import { existsSync } from 'fs'

let workspacePath = process.cwd()

export function registerWorkspaceIPC(): void {
  ipcMain.handle('workspace:get', () => workspacePath)

  ipcMain.handle('workspace:set', (_event, path: string) => {
    if (!existsSync(path)) {
      throw new Error(`Directory not found: ${path}`)
    }
    workspacePath = path
    process.chdir(path)
    return { ok: true, path }
  })
}

export function getWorkspacePath(): string {
  return workspacePath
}

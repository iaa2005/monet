/**
 * Permissions IPC handler — ask user for permission (async dialog).
 */

import { ipcMain, BrowserWindow } from 'electron'

export type PermissionRequest = {
  id: string
  toolName: string
  description: string
  detail?: string
}

export type PermissionDecision = 'allow' | 'deny' | 'allow-once'

export function registerPermissionsIPC(): void {
  ipcMain.handle(
    'permissions:ask',
    async (_event, request: PermissionRequest): Promise<PermissionDecision> => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return 'deny'

      // Send request to renderer and wait for response
      return new Promise(resolve => {
        win!.webContents.send('permissions:request', request)

        const handler = (_e: Electron.IpcMainEvent, decision: PermissionDecision) => {
          ipcMain.removeListener('permissions:response', handler)
          resolve(decision)
        }

        ipcMain.on('permissions:response', handler)

        // Timeout after 30s → deny
        setTimeout(() => {
          ipcMain.removeListener('permissions:response', handler)
          resolve('deny')
        }, 30000)
      })
    },
  )
}

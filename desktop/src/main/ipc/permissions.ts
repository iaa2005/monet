/**
 * Permissions IPC — the main→renderer permission round-trip.
 *
 * When a tool needs approval, the agent calls requestPermissionFromRenderer(),
 * which pushes a `permissions:request` to the renderer (PermissionDialog) and
 * resolves once the user answers via `permissions:response`. Tool execution is
 * sequential in the agent loop, so a single pending request at a time is fine.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'

export type PermissionRequest = {
  id: string
  toolName: string
  description: string
  detail?: string
}

export type PermissionDecision = 'allow' | 'deny' | 'allow-once'

/** Human decision timeout — long enough for a person to read and choose. */
const DECISION_TIMEOUT_MS = 5 * 60 * 1000

export function requestPermissionFromRenderer(
  win: BrowserWindow,
  ask: { toolName: string; description: string; detail?: string },
): Promise<PermissionDecision> {
  const request: PermissionRequest = { id: randomUUID(), ...ask }

  return new Promise(resolve => {
    let settled = false
    const finish = (decision: PermissionDecision): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener('permissions:response', handler)
      clearTimeout(timer)
      resolve(decision)
    }
    const handler = (
      _e: Electron.IpcMainEvent,
      decision: PermissionDecision,
    ): void => finish(decision)

    ipcMain.on('permissions:response', handler)
    const timer = setTimeout(() => finish('deny'), DECISION_TIMEOUT_MS)

    if (win.isDestroyed()) {
      finish('deny')
      return
    }
    win.webContents.send('permissions:request', request)
  })
}

/** Retained so the preload's typed bridge resolves; the real flow is the
 * push-based round-trip above, so this invoke handler is an inert fallback. */
export function registerPermissionsIPC(): void {
  ipcMain.handle('permissions:ask', () => 'deny' as PermissionDecision)
}

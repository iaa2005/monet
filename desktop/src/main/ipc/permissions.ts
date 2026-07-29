/**
 * Permissions IPC — the main→renderer permission round-trip.
 *
 * When a tool needs approval, the agent calls requestPermissionFromRenderer(),
 * which pushes a `permissions:request` to the renderer and resolves once the
 * user answers via `permissions:response`.
 *
 * Every request carries an id and every answer must quote it. That used to be
 * absent, on the stated assumption that tool execution is sequential so only
 * one request can be outstanding — but two chats can stream at once (runs are
 * keyed by session), and then a single `permissions:response` event fired
 * EVERY pending listener: one click approved both tools, including the one the
 * user never saw. The renderer queues requests so the second dialog cannot
 * replace the first either.
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

/** Outstanding requests, by id. More than one is normal: concurrent chats, and
 * concurrency-safe tools running in the same turn. */
const pending = new Map<string, (decision: PermissionDecision) => void>()

let listening = false

function ensureListener(): void {
  if (listening) return
  listening = true
  ipcMain.on(
    'permissions:response',
    (_e, payload: { id?: string; decision?: PermissionDecision } | PermissionDecision) => {
      // Tolerate the old shape (a bare decision) so a renderer that has not
      // reloaded yet still answers SOMETHING rather than hanging for five
      // minutes — but only when exactly one request is outstanding, because
      // that is the only case where the intent is unambiguous.
      if (typeof payload === 'string') {
        if (pending.size === 1) {
          const [[id, resolve]] = [...pending.entries()]
          pending.delete(id)
          resolve(payload)
        }
        return
      }
      const id = payload?.id
      const decision = payload?.decision
      if (!id || !decision) return
      const resolve = pending.get(id)
      if (!resolve) return // already timed out, or answered twice
      pending.delete(id)
      resolve(decision)
    },
  )
}

export function requestPermissionFromRenderer(
  win: BrowserWindow,
  ask: { toolName: string; description: string; detail?: string },
): Promise<PermissionDecision> {
  ensureListener()
  const request: PermissionRequest = { id: randomUUID(), ...ask }

  return new Promise(resolve => {
    let settled = false
    const finish = (decision: PermissionDecision): void => {
      if (settled) return
      settled = true
      pending.delete(request.id)
      clearTimeout(timer)
      resolve(decision)
    }
    const timer = setTimeout(() => finish('deny'), DECISION_TIMEOUT_MS)

    if (win.isDestroyed()) {
      finish('deny')
      return
    }
    pending.set(request.id, finish)
    win.webContents.send('permissions:request', request)
  })
}

/** Deny everything still outstanding — the window is going away, or the run
 * was aborted, and a dialog nobody can answer must not hold a tool open. */
export function cancelPendingPermissions(): void {
  for (const [id, resolve] of [...pending.entries()]) {
    pending.delete(id)
    resolve('deny')
  }
}

/** Retained so the preload's typed bridge resolves; the real flow is the
 * push-based round-trip above, so this invoke handler is an inert fallback. */
export function registerPermissionsIPC(): void {
  ipcMain.handle('permissions:ask', () => 'deny' as PermissionDecision)
}

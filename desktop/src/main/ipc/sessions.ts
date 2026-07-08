/**
 * Sessions IPC handler — CRUD for chat sessions.
 */

import { ipcMain } from 'electron'
import { getSessionStore, type Session, type SessionWithMessages } from '../session-store.js'

export function registerSessionsIPC(): void {
  const store = getSessionStore()

  ipcMain.handle('sessions:create', (_e, title?: string, space?: string): SessionWithMessages => {
    return store.create(title, space)
  })

  ipcMain.handle('sessions:get', (_e, id: string): SessionWithMessages | null => {
    return store.get(id)
  })

  ipcMain.handle('sessions:save', (_e, session: SessionWithMessages): void => {
    store.save(session)
  })

  ipcMain.handle('sessions:list', (_e, limit?: number, offset?: number, space?: string): Session[] => {
    return store.list(limit, offset, space)
  })

  ipcMain.handle('sessions:search', (_e, query: string, limit?: number): Session[] => {
    return store.search(query, limit)
  })

  ipcMain.handle('sessions:delete', (_e, id: string): boolean => {
    return store.delete(id)
  })

  ipcMain.handle('sessions:listArchived', (_e, space?: string): Session[] => {
    return store.listArchived(space)
  })

  ipcMain.handle('sessions:setArchived', (_e, id: string, archived: boolean): void => {
    store.setArchived(id, archived)
  })

  ipcMain.handle('sessions:setPinned', (_e, id: string, pinned: boolean): void => {
    store.setPinned(id, pinned)
  })

  ipcMain.handle('sessions:updateTitle', (_e, id: string, title: string): SessionWithMessages | null => {
    return store.updateTitle(id, title)
  })
}

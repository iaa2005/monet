/**
 * Session Store — JSON-file based session persistence.
 *
 * Stores sessions in userData/sessions/ as individual JSON files.
 * Replaces better-sqlite3 for MVP (no native compilation needed).
 */

import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../types/chat.js'

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionWithMessages extends Session {
  messages: ChatMessage[]
}

function getSessionsDir(): string {
  const dir = join(app.getPath('userData'), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`)
}

// ─── Public API ─────────────────────────────────────────────────────────

export class SessionStore {
  create(title?: string): SessionWithMessages {
    const id = randomUUID()
    const now = new Date().toISOString()
    const session: SessionWithMessages = {
      id,
      title: title || 'New Session',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    }
    writeFileSync(sessionPath(id), JSON.stringify(session, null, 2), 'utf-8')
    return session
  }

  get(id: string): SessionWithMessages | null {
    const path = sessionPath(id)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return null
    }
  }

  save(session: SessionWithMessages): void {
    session.updatedAt = new Date().toISOString()
    session.messageCount = session.messages.length
    writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8')
  }

  addMessage(sessionId: string, message: ChatMessage): SessionWithMessages | null {
    const session = this.get(sessionId)
    if (!session) return null

    session.messages.push(message)
    this.save(session)
    return session
  }

  list(limit = 50, offset = 0): Session[] {
    const dir = getSessionsDir()
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const data = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
            return {
              id: data.id,
              title: data.title,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              messageCount: data.messageCount || data.messages?.length || 0,
            } as Session
          } catch {
            return null
          }
        })
        .filter((s): s is Session => s !== null)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

      return files.slice(offset, offset + limit)
    } catch {
      return []
    }
  }

  search(query: string, limit = 20): Session[] {
    const q = query.toLowerCase()
    return this.list(1000)
      .filter(s => s.title.toLowerCase().includes(q))
      .slice(0, limit)
  }

  delete(id: string): boolean {
    const path = sessionPath(id)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  updateTitle(id: string, title: string): SessionWithMessages | null {
    const session = this.get(id)
    if (!session) return null

    session.title = title
    this.save(session)
    return session
  }
}

let instance: SessionStore | null = null

export function getSessionStore(): SessionStore {
  if (!instance) instance = new SessionStore()
  return instance
}

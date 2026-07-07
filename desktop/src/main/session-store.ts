/**
 * Session Store — SQLite-based session persistence.
 *
 * Uses better-sqlite3 (compiled for Electron's Node.js).
 * Tables: sessions, messages.
 */

import { app } from "electron";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: string;
    status: string;
  };
  isStreaming?: boolean;
  isError?: boolean;
}

export interface SessionWithMessages extends Session {
  messages: ChatMessage[];
}

function getDbPath(): string {
  const dir = join(app.getPath("userData"), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "sessions.db");
}

let db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_call TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    `);
  }
  return db;
}

export class SessionStore {
  create(title?: string): SessionWithMessages {
    const d = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    d.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, 0)",
    ).run(id, title || "New Session", now, now);
    return {
      id,
      title: title || "New Session",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    };
  }

  get(id: string): SessionWithMessages | null {
    const d = getDb();
    const s = d.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }
      | undefined;
    if (!s) return null;

    const msgs = d
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
      )
      .all(id) as Array<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      tool_call: string | null;
    }>;

    return {
      id: s.id,
      title: s.title,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      messageCount: s.message_count,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role as ChatMessage["role"],
        content: m.content,
        timestamp: m.timestamp,
        toolCall: m.tool_call ? JSON.parse(m.tool_call) : undefined,
      })),
    };
  }

  save(session: SessionWithMessages): void {
    const d = getDb();
    const now = new Date().toISOString();
    const tx = d.transaction(() => {
      d.prepare(
        "UPDATE sessions SET title = ?, updated_at = ?, message_count = ? WHERE id = ?",
      ).run(session.title, now, session.messages.length, session.id);

      // Replace messages
      d.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);
      const insert = d.prepare(
        "INSERT INTO messages (id, session_id, role, content, timestamp, tool_call) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const m of session.messages) {
        insert.run(
          m.id || randomUUID(),
          session.id,
          m.role,
          m.content,
          m.timestamp,
          m.toolCall ? JSON.stringify(m.toolCall) : null,
        );
      }
    });
    tx();
  }

  addMessage(
    sessionId: string,
    message: ChatMessage,
  ): SessionWithMessages | null {
    const d = getDb();
    const s = d
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as
      | {
          id: string;
          title: string;
          created_at: string;
          updated_at: string;
          message_count: number;
        }
      | undefined;
    if (!s) return null;

    d.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp, tool_call) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      message.id || randomUUID(),
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCall ? JSON.stringify(message.toolCall) : null,
    );

    const count = d
      .prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
      .get(sessionId) as { c: number };
    d.prepare(
      "UPDATE sessions SET message_count = ?, updated_at = ? WHERE id = ?",
    ).run(count.c, new Date().toISOString(), sessionId);

    return this.get(sessionId);
  }

  list(limit = 50, offset = 0): Session[] {
    const d = getDb();
    return d
      .prepare(
        "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as Session[];
  }

  search(query: string, limit = 20): Session[] {
    const d = getDb();
    return d
      .prepare(
        "SELECT * FROM sessions WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(`%${query}%`, limit) as Session[];
  }

  delete(id: string): boolean {
    const d = getDb();
    const result = d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updateTitle(id: string, title: string): SessionWithMessages | null {
    const d = getDb();
    d.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
      title,
      new Date().toISOString(),
      id,
    );
    return this.get(id);
  }
}

let instance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!instance) instance = new SessionStore();
  return instance;
}

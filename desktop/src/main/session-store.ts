/**
 * Session Store — SQLite-based session persistence.
 *
 * Uses better-sqlite3 (compiled for Electron's Node.js).
 * Tables: sessions, messages.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import { createRequire } from "module";
import { getDataSubdir } from "./data-dir.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  archived?: boolean;
  pinned?: boolean;
  /** Per-chat working directory (restored when the chat is opened). */
  workspace?: string;
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

export interface StatsResult {
  sessions: number;
  messages: number;
  userMessages: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  approxTokens: number;
  perDay: { date: string; count: number }[];
}

interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  archived?: number;
  pinned?: number;
  workspace?: string | null;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    archived: !!r.archived,
    pinned: !!r.pinned,
    workspace: r.workspace ?? undefined,
  };
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function getDbPath(): string {
  const dir = getDataSubdir("sessions");
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
        message_count INTEGER DEFAULT 0,
        space TEXT NOT NULL DEFAULT 'code',
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0
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
    // Migrate older DBs that predate the space column (default existing chats
    // to the Code space, since that's where they were created).
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as {
      name: string;
    }[];
    const has = (n: string): boolean => cols.some((c) => c.name === n);
    if (!has("space"))
      db.exec(
        "ALTER TABLE sessions ADD COLUMN space TEXT NOT NULL DEFAULT 'code'",
      );
    if (!has("archived"))
      db.exec(
        "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      );
    if (!has("pinned"))
      db.exec(
        "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
      );
    // Per-chat working directory: each session remembers its own folder.
    if (!has("workspace"))
      db.exec("ALTER TABLE sessions ADD COLUMN workspace TEXT");
  }
  return db;
}

export class SessionStore {
  create(title?: string, space: string = "code"): SessionWithMessages {
    const d = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    d.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, message_count, space) VALUES (?, ?, ?, ?, 0, ?)",
    ).run(id, title || "New Session", now, now, space);
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
          workspace?: string | null;
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
      workspace: s.workspace ?? undefined,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role as ChatMessage["role"],
        content: m.content,
        timestamp: m.timestamp,
        toolCall: m.tool_call ? JSON.parse(m.tool_call) : undefined,
      })),
    };
  }

  /** Remember a chat's working directory. */
  setWorkspace(id: string, workspace: string): void {
    getDb()
      .prepare("UPDATE sessions SET workspace = ? WHERE id = ?")
      .run(workspace, id);
  }

  save(session: SessionWithMessages): void {
    const d = getDb();
    const now = new Date().toISOString();
    const tx = d.transaction(() => {
      d.prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, message_count = excluded.message_count",
      ).run(session.id, session.title, now, now, session.messages.length);

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

  list(
    limit = 50,
    offset = 0,
    space?: string,
    status = "all",
    sort = "recency",
    sortDir = "desc",
  ): Session[] {
    const d = getDb();
    let query = "SELECT * FROM sessions WHERE 1=1";
    const params: (string | number)[] = [];

    if (space) {
      query += " AND space = ?";
      params.push(space);
    }
    if (status === "active") {
      query += " AND archived = 0";
    } else if (status === "archived") {
      query += " AND archived = 1";
    }

    const dir = sortDir === "asc" ? "ASC" : "DESC";
    const orderBy =
      sort === "name"
        ? `title ${dir}`
        : sort === "activity"
          ? `message_count ${dir}, updated_at ${dir}`
          : `pinned DESC, updated_at ${dir}`;

    query += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = d.prepare(query).all(...params) as SessionRow[];
    return rows.map(rowToSession);
  }

  listArchived(space?: string): Session[] {
    const d = getDb();
    const rows = (
      space
        ? d
            .prepare(
              "SELECT * FROM sessions WHERE archived = 1 AND space = ? ORDER BY updated_at DESC",
            )
            .all(space)
        : d
            .prepare(
              "SELECT * FROM sessions WHERE archived = 1 ORDER BY updated_at DESC",
            )
            .all()
    ) as SessionRow[];
    return rows.map(rowToSession);
  }

  setArchived(id: string, archived: boolean): void {
    getDb()
      .prepare("UPDATE sessions SET archived = ? WHERE id = ?")
      .run(archived ? 1 : 0, id);
  }

  setPinned(id: string, pinned: boolean): void {
    getDb()
      .prepare("UPDATE sessions SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  search(query: string, limit = 20): Session[] {
    const d = getDb();
    const rows = d
      .prepare(
        "SELECT * FROM sessions WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(`%${query}%`, limit) as SessionRow[];
    return rows.map(rowToSession);
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

  stats(rangeDays?: number): StatsResult {
    const d = getDb();
    const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : 0;
    const rows = d
      .prepare(
        "SELECT session_id, role, content, timestamp FROM messages WHERE timestamp >= ? ORDER BY timestamp ASC",
      )
      .all(cutoff) as {
      session_id: string;
      role: string;
      content: string;
      timestamp: number;
    }[];

    const sessionIds = new Set<string>();
    const dayCounts = new Map<string, number>();
    const hourCounts = new Array<number>(24).fill(0);
    let approxTokens = 0;
    let userMessages = 0;

    for (const r of rows) {
      sessionIds.add(r.session_id);
      approxTokens += Math.ceil((r.content?.length ?? 0) / 4);
      if (r.role === "user") userMessages++;
      dayCounts.set(
        localDay(r.timestamp),
        (dayCounts.get(localDay(r.timestamp)) ?? 0) + 1,
      );
      hourCounts[new Date(r.timestamp).getHours()]++;
    }

    const days = [...dayCounts.keys()].sort();
    let currentStreak = 0;
    let longestStreak = 0;
    let run = 0;
    let prev: number | null = null;
    for (const day of days) {
      const t = Date.parse(day);
      run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      prev = t;
    }
    const daySet = new Set(days);
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (daySet.has(localDay(cursor.getTime()))) {
      currentStreak++;
      cursor.setTime(cursor.getTime() - 86400000);
    }

    let peakHour: number | null = null;
    let peakVal = 0;
    hourCounts.forEach((v, h) => {
      if (v > peakVal) {
        peakVal = v;
        peakHour = h;
      }
    });

    return {
      sessions: sessionIds.size,
      messages: rows.length,
      userMessages,
      activeDays: dayCounts.size,
      currentStreak,
      longestStreak,
      peakHour,
      approxTokens,
      perDay: days.map((date) => ({ date, count: dayCounts.get(date) ?? 0 })),
    };
  }
}

let instance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!instance) instance = new SessionStore();
  return instance;
}

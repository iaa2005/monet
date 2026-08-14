/**
 * Sessions IPC handler — CRUD for chat sessions.
 */

import { BrowserWindow, ipcMain } from "electron";
import { getMainWindow } from "../app/main-window.js";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  getSessionStore,
  type Session,
  type SessionWithMessages,
} from "../session/store.js";
import { createAdapter } from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { purgeSessionData } from "../session/purge.js";
import { getDataSubdir } from "../data-dir.js";
import { sessionSlug } from "../agent/checkpoint-store.js";
import { forgetSession } from "../agent/index.js";

async function generateSessionTitle(
  session: SessionWithMessages,
): Promise<string | null> {
  const provider = getProviderManager().getActive();
  if (!provider) return null;

  const conversation = session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n")
    .slice(0, 4000);
  if (!conversation) return null;

  const result = await createAdapter(provider).complete({
    model: provider.model,
    system:
      "Name this chat. Reply with ONLY a concise 3-6 word title in the language of the conversation. No quotes, no trailing punctuation.",
    messages: [{ role: "user", content: conversation }],
    max_tokens: 24,
  });
  const title = (typeof result.content === "string" ? result.content : "")
    .trim()
    .replace(/^['\"«]+|['\"»]+$/g, "")
    .split("\n")[0]
    .slice(0, 60);
  return title || null;
}

export function registerSessionsIPC(): void {
  const store = getSessionStore();

  ipcMain.handle(
    "sessions:create",
    (_e, title?: string, space?: string): SessionWithMessages => {
      return store.create(title, space);
    },
  );

  ipcMain.handle(
    "sessions:get",
    (_e, id: string): SessionWithMessages | null => {
      return store.get(id);
    },
  );

  ipcMain.handle("sessions:save", (_e, session: SessionWithMessages): void => {
    store.save(session);
  });

  ipcMain.handle(
    "sessions:list",
    (
      _e,
      limit?: number,
      offset?: number,
      space?: string,
      status?: string,
      sort?: string,
      sortDir?: string,
      activityDays?: number,
    ): Session[] => {
      return store.list(limit, offset, space, status, sort, sortDir, activityDays);
    },
  );

  ipcMain.handle(
    "sessions:search",
    (_e, query: string, limit?: number): Session[] => {
      return store.search(query, limit);
    },
  );

  ipcMain.handle("sessions:delete", (_e, id: string): boolean => {
    // Everything the chat owns on DISK — DB rows in both stores, its three
    // directories, its desk, its goal, its engine override — lives in ONE
    // function, so a store added later has a single place to register.
    purgeSessionData(id);
    // …and what the agent was holding in memory for it. Nothing emptied
    // these, so a deleted chat freed its rows and its folders and kept the
    // expensive part — the whole conversation — for the life of the process.
    forgetSession(id);
    return store.delete(id);
  });

  ipcMain.handle("sessions:listArchived", (_e, space?: string): Session[] => {
    return store.listArchived(space);
  });

  ipcMain.handle(
    "sessions:setArchived",
    (_e, id: string, archived: boolean): void => {
      store.setArchived(id, archived);
    },
  );

  ipcMain.handle(
    "sessions:setPinned",
    (_e, id: string, pinned: boolean): void => {
      store.setPinned(id, pinned);
    },
  );

  ipcMain.handle(
    "sessions:setWorkspace",
    (_e, id: string, workspace: string): void => {
      store.setWorkspace(id, workspace);
    },
  );

  ipcMain.handle(
    "sessions:updateTitle",
    async (_e, id: string, title: string): Promise<SessionWithMessages | null> => {
      const session = store.get(id);
      if (!session) return null;

      const nextTitle = title.trim()
        ? title.trim().slice(0, 60)
        : await generateSessionTitle(session);
      if (!nextTitle) return session;

      const updated = store.updateTitle(id, nextTitle);
      const win = getMainWindow();
      win?.webContents.send("sessions:titleChanged", {
        sessionId: id,
        title: nextTitle,
      });
      return updated;
    },
  );
}

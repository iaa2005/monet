/**
 * Incognito hygiene — incognito means NOTHING survives the chat.
 *
 * A closed incognito chat leaves data in three places: the artifacts dir
 * (sandbox outputs), the subprocess sandbox dir, and the Pyodide worker's
 * in-memory session. purgeIncognitoData() wipes all of them (plus the
 * main-process conversation history). purgeIncognitoLeftovers() runs at app
 * startup and removes every incognito-* directory that a crash left behind —
 * if the user didn't download a file, that's the point of incognito.
 */

import { ipcMain } from "electron";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import { resetConversation } from "../agent/index.js";
import { wipePyodideSession } from "../sandbox/pyodide-engine.js";
import { purgeSessionData } from "./purge.js";

function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
}

function rmDir(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[incognito] failed to remove ${path}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Wipe every trace of one incognito session. */
export function purgeIncognitoData(sessionId: string): void {
  if (!sessionId.startsWith("incognito-")) return; // never touch normal chats
  // The same purge a deleted chat gets — an incognito chat used to keep only
  // its two directories, so its transcript stayed in the database forever
  // (found one in a real install, next to 462 from ordinary deletes).
  purgeSessionData(sessionId);
  wipePyodideSession(sessionId);
  resetConversation(sessionId);
  console.log(`[incognito] purged ${sessionId}`);
}

/** Startup sweep: remove incognito leftovers from a crashed/killed run. */
export function purgeIncognitoLeftovers(): void {
  for (const root of ["artifacts", "sandboxes"]) {
    const base = getDataSubdir(root);
    let entries: string[] = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("incognito-")) continue;
      const full = join(base, name);
      try {
        if (statSync(full).isDirectory()) rmDir(full);
      } catch {
        /* skip */
      }
    }
  }
}

export function registerIncognitoIPC(): void {
  ipcMain.handle(
    "incognito:purge",
    (_e, sessionId: string): { ok: boolean } => {
      purgeIncognitoData(sessionId);
      return { ok: true };
    },
  );
}

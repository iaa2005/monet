/**
 * Settings IPC — app-level settings (currently the data directory location).
 */
import { ipcMain, dialog, BrowserWindow } from "electron";
import { existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

// better-sqlite3 is a native CJS module; the ESM bundle needs this to
// reach it, and the inspection below is the only place here that does.
const require = createRequire(import.meta.url);
import { getDataDir, setDataDir, isDefaultDataDir } from "../data-dir.js";
import { getUiPrefs, setUiPrefs, type UiPrefs } from "../app/ui-prefs.js";
import { closeSessionDb } from "../session/store.js";
import { resetProviderManager } from "../provider/manager.js";

export function registerSettingsIPC(): void {
  // Preferences that outlive the window — currently how the sessions list
  // is filtered and drawn. In <dataDir>/ui-prefs.json rather than in the
  // renderer's localStorage, which in dev is keyed by an origin carrying
  // vite's port and loses everything the moment the port moves.
  ipcMain.handle("settings:uiPrefs", (): UiPrefs => getUiPrefs());
  ipcMain.handle(
    "settings:setUiPrefs",
    (_e, patch: Partial<UiPrefs>): UiPrefs => setUiPrefs(patch),
  );

  ipcMain.handle("settings:getDataDir", () => ({
    dir: getDataDir(),
    isDefault: isDefaultDataDir(),
  }));

  ipcMain.handle("settings:setDataDir", (_e, dir: string) => {
    setDataDir(dir);
    // Everything in the data dir is read per call and follows the switch for
    // free — except a database handle and a loaded provider list, which are
    // held. Dropping both is what makes "choose your existing folder" during
    // first-run setup show that folder's own chats, providers and profile
    // rather than the ones the app happened to start with.
    //
    // Not everything catches up: a sandbox already provisioned, a model
    // already loaded into memory. Those need the restart the UI mentions.
    closeSessionDb();
    resetProviderManager();
    return { ok: true };
  });

  /**
   * Is there already a Code Monet folder here?
   *
   * Somebody moving the app to a new machine, or pointing it at a folder on
   * a drive they keep their work on, is ADOPTING data rather than choosing
   * where to put some. Nothing about the switch destroys anything either way
   * — it writes a path, it does not copy or clear — but the setup screen has
   * to be able to SAY which of the two just happened. A first run that
   * silently swallows an existing library is indistinguishable, to the person
   * doing it, from one that lost it.
   */
  ipcMain.handle(
    "settings:inspectDataDir",
    (_e, dir: string): { exists: boolean; hasData: boolean; chats: number } => {
      try {
        if (!dir || !existsSync(dir)) return { exists: false, hasData: false, chats: 0 };
        // <dataDir>/sessions/sessions.db — NOT the root. Looking in the
        // root found nothing and reported a folder full of chats as empty.
        const db = join(dir, "sessions", "sessions.db");
        const hasData =
          existsSync(db) ||
          existsSync(join(dir, "providers", "providers.json")) ||
          existsSync(join(dir, "ui-prefs.json"));
        let chats = 0;
        if (existsSync(db)) {
          try {
            // Read-only, and its own connection: the live one belongs to the
            // folder the app is USING, which is not the one being inspected.
            // Untyped on purpose, exactly as session/store.ts does it: the
            // package ships no declarations and only two calls are used.
            const Database = require("better-sqlite3");
            const probe = new Database(db, {
              readonly: true,
              fileMustExist: true,
            }) as {
              prepare: (sql: string) => { get: () => unknown };
              close: () => void;
            };
            const row = probe
              .prepare("SELECT COUNT(*) AS n FROM sessions")
              .get() as { n?: number } | undefined;
            chats = Number(row?.n ?? 0);
            probe.close();
          } catch (err) {
            // An older schema, a WAL file another instance holds, a lock —
            // the count is a nicety and its absence must not read as zero.
            chats = -1;
            console.warn(
              "[settings] could not count chats in",
              dir,
              err instanceof Error ? err.message : err,
            );
          }
        }
        return { exists: true, hasData, chats };
      } catch {
        return { exists: false, hasData: false, chats: 0 };
      }
    },
  );

  ipcMain.handle("settings:pickDataDir", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      title: "Choose a data folder",
      properties: ["openDirectory" as const, "createDirectory" as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = result.filePaths[0];
    setDataDir(dir);
    return dir;
  });
}

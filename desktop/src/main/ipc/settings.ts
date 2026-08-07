/**
 * Settings IPC — app-level settings (currently the data directory location).
 */
import { ipcMain, dialog, BrowserWindow } from "electron";
import { getDataDir, setDataDir, isDefaultDataDir } from "../data-dir.js";
import { getUiPrefs, setUiPrefs, type UiPrefs } from "../app/ui-prefs.js";

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
    return { ok: true };
  });

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

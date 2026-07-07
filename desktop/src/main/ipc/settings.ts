/**
 * Settings IPC — app-level settings (currently the data directory location).
 */
import { ipcMain, dialog, BrowserWindow } from "electron";
import { getDataDir, setDataDir, isDefaultDataDir } from "../data-dir.js";

export function registerSettingsIPC(): void {
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
      properties: ["openDirectory", "createDirectory"] as const,
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

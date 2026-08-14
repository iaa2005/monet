/**
 * Auto-update — GitHub Releases as the feed, electron-updater as the engine.
 *
 * The flow is deliberately quiet: the update downloads in the background and
 * NOTHING interrupts the user — the only surface is the "Relaunch to update"
 * pill the sidebar shows once the new version is on disk, and the app also
 * installs it on ordinary quit (autoInstallOnAppQuit), so even an ignored
 * pill updates eventually.
 *
 * Dev builds have no update feed (app-update.yml exists only in packaged
 * apps), so everything but the IPC handlers is gated on app.isPackaged — the
 * handlers stay registered so the renderer can always ask and simply hear
 * "nothing pending".
 */

import { app, ipcMain } from "electron";
import { getMainWindow } from "./main-window.js";

let pendingVersion: string | null = null;

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export function startAutoUpdater(): void {
  ipcMain.handle("update:pending", () => pendingVersion);
  ipcMain.handle("update:install", async () => {
    if (!app.isPackaged || !pendingVersion) return;
    const { autoUpdater } = await import("electron-updater");
    // setImmediate: let the invoke resolve before the app starts tearing
    // itself down, or the renderer dies waiting on a reply.
    setImmediate(() => autoUpdater.quitAndInstall());
  });

  if (!app.isPackaged) return;

  void (async () => {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("update-downloaded", (info) => {
        pendingVersion = info.version;
        const win = getMainWindow();
        if (win && !win.isDestroyed())
          win.webContents.send("update:ready", { version: info.version });
      });
      // An offline check is Tuesday, not an incident.
      autoUpdater.on("error", (err) =>
        console.warn("[updater]", err instanceof Error ? err.message : err),
      );
      const check = (): void =>
        void autoUpdater.checkForUpdates().catch(() => {});
      check();
      setInterval(check, CHECK_EVERY_MS);
    } catch (err) {
      console.warn(
        "[updater] unavailable:",
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

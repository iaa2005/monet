/**
 * Auto-update — GitHub Releases as the feed, electron-updater as the engine.
 *
 * The download is the USER's call, not ours. It used to start by itself and
 * say nothing until it was over; when 0.1.0 never managed to finish one,
 * nothing on screen ever said so — the only surface was a pill that appears
 * after success, so a failure and an app with no update looked identical.
 * Every step is now a state the renderer can see:
 *
 *   idle → available (a version, and how big) → downloading (percent)
 *        → ready (relaunch now, or it installs on the next ordinary quit)
 *   …and error, which is a state like any other, carrying WHY.
 *
 * autoInstallOnAppQuit stays on: a user who downloaded and then ignored the
 * pill still gets the version they asked for, next time they close the app.
 *
 * Dev builds have no update feed (app-update.yml exists only in packaged
 * apps), so everything but the IPC is gated on app.isPackaged — the handlers
 * stay registered so the renderer can always ask and simply hear "idle".
 */

import { app, ipcMain } from "electron";
import { getMainWindow } from "./main-window.js";
import { describeError } from "../net/download.js";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string; bytes?: number }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string; version?: string };

let state: UpdateState = { status: "idle" };

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** The state as it is NOW — read it through this after an await. A direct
 * `state.status` there is checked against the narrowing from before the
 * await, and by then the engine's events have usually moved it on. */
function current(): UpdateState {
  return state;
}

function setState(next: UpdateState): void {
  state = next;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send("update:state", next);
}

/** The engine, loaded lazily — it reads app-update.yml at import time. */
async function updater(): Promise<typeof import("electron-updater").autoUpdater> {
  const { autoUpdater } = await import("electron-updater");
  return autoUpdater;
}

export function startAutoUpdater(): void {
  ipcMain.handle("update:state", () => state);

  ipcMain.handle("update:check", async (): Promise<UpdateState> => {
    if (!app.isPackaged) return state;
    // A check while something is already happening would throw away a
    // download in flight; the state IS the answer in that case.
    if (state.status === "downloading" || state.status === "ready") return state;
    setState({ status: "checking" });
    try {
      const au = await updater();
      const result = await au.checkForUpdates();
      // No result, or the same version we are running: nothing to offer. The
      // 'update-available' event has already set the state when there is one,
      // so this only closes the case the events left open.
      if (current().status === "checking") {
        const found = result?.updateInfo?.version;
        setState(
          found && found !== app.getVersion()
            ? { status: "available", version: found }
            : { status: "idle" },
        );
      }
    } catch (err) {
      setState({ status: "error", message: describeError(err) });
    }
    return state;
  });

  ipcMain.handle("update:download", async (): Promise<UpdateState> => {
    if (!app.isPackaged) return state;
    if (state.status !== "available" && state.status !== "error") return state;
    const version = state.version;
    if (!version) return state;
    setState({ status: "downloading", version, percent: 0 });
    try {
      const au = await updater();
      await au.downloadUpdate();
      // 'update-downloaded' sets `ready`; if the engine resolved without it
      // (a cached download), say ready anyway rather than spin forever.
      if (current().status === "downloading")
        setState({ status: "ready", version });
    } catch (err) {
      setState({ status: "error", message: describeError(err), version });
    }
    return state;
  });

  ipcMain.handle("update:install", async () => {
    if (!app.isPackaged || state.status !== "ready") return;
    const au = await updater();
    // setImmediate: let the invoke resolve before the app starts tearing
    // itself down, or the renderer dies waiting on a reply.
    setImmediate(() => au.quitAndInstall());
  });

  if (!app.isPackaged) return;

  void (async () => {
    try {
      const au = await updater();
      au.autoDownload = false;
      au.autoInstallOnAppQuit = true;
      au.on("update-available", (info) =>
        setState({
          status: "available",
          version: info.version,
          bytes: info.files?.[0]?.size,
        }),
      );
      au.on("update-not-available", () => {
        if (state.status === "checking") setState({ status: "idle" });
      });
      au.on("download-progress", (p) => {
        if (state.status !== "downloading" && state.status !== "available") return;
        setState({
          status: "downloading",
          version: state.version,
          percent: Math.max(0, Math.min(100, Math.round(p.percent))),
        });
      });
      au.on("update-downloaded", (info) =>
        setState({ status: "ready", version: info.version }),
      );
      // An offline check is Tuesday, not an incident — but a failure DURING a
      // download the user started is news, and it reaches them as one.
      au.on("error", (err) => {
        console.warn("[updater]", err instanceof Error ? err.message : err);
        if (state.status === "downloading" || state.status === "checking")
          setState({
            status: "error",
            message: describeError(err),
            version: state.status === "downloading" ? state.version : undefined,
          });
      });
      const check = (): void => void au.checkForUpdates().catch(() => {});
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

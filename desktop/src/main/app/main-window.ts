/**
 * The app's one real window, as a leaf module any IPC handler can import.
 *
 * `BrowserWindow.getAllWindows()[0]` used to stand in for "the app window"
 * all over main. That held only while the app HAD one window — the moment
 * Computer Use's glow overlay (a second, listener-less BrowserWindow) was
 * created, [0] could be the overlay, and every chat:token of every later
 * run streamed into a page that renders a border: eternal spinner, Stop
 * doing nothing, the whole turn missing from the DB. Found live on
 * 2026-08-14 after two "lost" turns.
 *
 * A leaf with a setter (not an export from index.ts) because index.ts
 * imports the IPC registrars — importing back would cycle.
 */

import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

/** The app window, or null before creation / after destruction. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

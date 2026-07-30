/**
 * Which <webview> is which.
 *
 * The renderer owns the tab strip; main owns the tools. They meet here: the
 * renderer reports a tab's webContents id once the guest is attached, and main
 * looks up the WebContents to drive it.
 *
 * Ids are reported rather than discovered because guessing is worse than it
 * looks — `webContents.getAllWebContents()` returns every guest in every
 * window, in creation order, with no way to tell which tab the user is looking
 * at. The renderer is the only side that knows that.
 */

import { BrowserWindow, webContents, type WebContents } from "electron";

interface TabRecord {
  id: string;
  webContentsId: number;
}

const tabs = new Map<string, TabRecord>();
let activeId: string | null = null;
/** Resolvers for ensureTab(), woken by the next registration. */
let waiters: (() => void)[] = [];

export function registerTab(id: string, webContentsId: number): void {
  tabs.set(id, { id, webContentsId });
  // First tab registered is the one to drive until told otherwise, so a tool
  // called before the user has clicked anything still has a target.
  if (!activeId) activeId = id;
  const woken = waiters;
  waiters = [];
  for (const resolve of woken) resolve();
}

export function unregisterTab(id: string): void {
  tabs.delete(id);
  if (activeId === id) activeId = tabs.keys().next().value ?? null;
}

export function setActiveTab(id: string): void {
  if (tabs.has(id)) activeId = id;
}

export function activeTabId(): string | null {
  return activeId;
}

/** The WebContents the tools act on, or null when the panel has no page. */
export function activeContents(): WebContents | null {
  const rec = activeId ? tabs.get(activeId) : null;
  if (!rec) return null;
  const wc = webContents.fromId(rec.webContentsId);
  // A crashed or closed guest leaves a stale id behind; drop it rather than
  // handing the tools a target that will throw on every call.
  if (!wc || wc.isDestroyed()) {
    tabs.delete(rec.id);
    if (activeId === rec.id) activeId = tabs.keys().next().value ?? null;
    return null;
  }
  return wc;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** Live state of every open tab — url and title read from the guests. */
export function listTabs(): TabInfo[] {
  const out: TabInfo[] = [];
  for (const rec of tabs.values()) {
    const wc = webContents.fromId(rec.webContentsId);
    if (!wc || wc.isDestroyed()) continue;
    out.push({
      id: rec.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      active: rec.id === activeId,
    });
  }
  return out;
}

/**
 * Make sure there IS a page to drive, opening one in the panel if not.
 *
 * The renderer owns tab creation — it also has to show the panel, since a tool
 * driving a browser nobody can see is how you end up trusting a screenshot of
 * the wrong page. So main asks and waits for the registration to come back.
 */
export async function ensureTab(url: string, timeoutMs = 10_000): Promise<void> {
  if (activeContents()) return;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error("No app window is open.");

  const registered = new Promise<void>((resolve) => waiters.push(resolve));
  win.webContents.send("browser:openTab", url);

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([registered, expired]);
  if (timer) clearTimeout(timer);

  if (!activeContents())
    throw new Error("The Browser panel did not open a tab in time.");
}

export function tabContents(id: string): WebContents | null {
  const rec = tabs.get(id);
  if (!rec) return null;
  const wc = webContents.fromId(rec.webContentsId);
  return wc && !wc.isDestroyed() ? wc : null;
}

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
import { getMainWindow } from "../app/main-window.js";

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
  // Off-screen run: its pages live in the hidden layer. The visible panel is
  // not touched at all — the user asked in chat A and is reading chat B.
  {
    const { currentRunSession } = await import("../agent/run-session.js");
    const { getVisibleChatSession } = await import("../session/visible.js");
    const sid = currentRunSession();
    console.log(`[headless] ensureTab sid=${sid?.slice(0, 8) ?? "none"} visible=${getVisibleChatSession()?.slice(0, 8) ?? "none"}`);
    if (sid && sid !== getVisibleChatSession()) {
      const { headlessContents, openHeadlessTab } = await import("./headless.js");
      if (!headlessContents(sid)) await openHeadlessTab(sid, url);
      return;
    }
  }
  if (activeContents()) return;
  await askPanelForTab(url, timeoutMs);
}

/**
 * Open ANOTHER tab, whether or not one is already open.
 *
 * ensureTab returns early when the panel has a page — right for "make sure
 * there is somewhere to act", wrong for "I want a second site open beside the
 * first". Without this the agent had no way to reach two pages at once:
 * navigate reused the current tab, and window.open from BrowserEval is
 * stopped by the popup blocker, a scripted open being no user gesture.
 */
export async function openNewTab(url: string, timeoutMs = 10_000): Promise<void> {
  await askPanelForTab(url, timeoutMs);
}

async function askPanelForTab(url: string, timeoutMs: number): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
  if (!win) throw new Error("No app window is open.");

  // Counted, not compared by id: whether the panel makes the new tab the
  // active one is its business, and a check that assumed it would turn a
  // successful open into a spurious failure.
  const before = listTabs().length;
  const registered = new Promise<void>((resolve) => waiters.push(resolve));
  // Tag the request with the run's session: the renderer files the tab on
  // that chat's desk instead of whichever chat is on screen.
  const { currentRunSession } = await import("../agent/run-session.js");
  win.webContents.send("browser:openTab", url, currentRunSession());

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([registered, expired]);
  if (timer) clearTimeout(timer);

  if (!activeContents() || listTabs().length <= before)
    throw new Error("The Browser panel did not open a tab in time.");
}

/**
 * Bring the Browser panel on screen, and give it a frame to paint.
 *
 * Not a courtesy — a requirement. The panel keeps inactive tabs alive by
 * parking them off-screen, and Chromium produces no frame for one: a capture
 * of a parked guest never answers (measured in scripts/webview-probe.cjs).
 * Anything visual has to ask for the page to be visible first.
 *
 * It is also the honest behaviour: a screenshot the user cannot see being
 * taken is a screenshot they cannot check.
 */
export async function revealPanel(): Promise<void> {
  // An off-screen run's page lives in the hidden layer, which paints frames
  // without being shown — revealing the panel here opened a browser in
  // whatever chat the USER was reading. Only a run whose chat is visible
  // needs (or deserves) the panel brought up.
  {
    const { currentRunSession } = await import("../agent/run-session.js");
    const { getVisibleChatSession } = await import("../session/visible.js");
    const sid = currentRunSession();
    if (sid && sid !== getVisibleChatSession()) return;
  }
  const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("browser:reveal");
  // One paint at 60Hz is ~16ms; this is the panel animating open and the guest
  // getting its first frame back.
  await new Promise((r) => setTimeout(r, 350));
}

export function tabContents(id: string): WebContents | null {
  const rec = tabs.get(id);
  if (!rec) return null;
  const wc = webContents.fromId(rec.webContentsId);
  return wc && !wc.isDestroyed() ? wc : null;
}

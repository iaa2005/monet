/**
 * The browser layer a run works in when its chat is NOT on screen.
 *
 * The visible Browser panel used to be the only place a page could live, so a
 * run that needed one while the user sat in another chat had to open its tab
 * in front of them — and the tab then belonged to whatever desk happened to
 * be watching. Every run now has a second place: hidden BrowserWindows, one
 * per tab, owned by the run's session. The tools drive their webContents
 * exactly like a visible tab's (same transport), screenshots and navigation
 * included; nobody sees a thing.
 *
 * The visible panel becomes a PROJECTION: entering a chat adopts its headless
 * tabs into the panel (by URL — page state does not survive the hop, which a
 * reading/screenshotting agent tolerates); leaving a chat whose run is still
 * working hands its tabs back into the hidden layer. One browser per chat,
 * shown only while you are there.
 */

import { BrowserWindow, type WebContents } from "electron";

interface HeadlessTab {
  win: BrowserWindow;
}

const bySession = new Map<string, HeadlessTab[]>();

function alive(t: HeadlessTab): boolean {
  return !t.win.isDestroyed() && !t.win.webContents.isDestroyed();
}

function tabsOf(sessionId: string): HeadlessTab[] {
  const list = (bySession.get(sessionId) ?? []).filter(alive);
  bySession.set(sessionId, list);
  return list;
}

/** Open a hidden page for this session and wait for it to be drivable. */
export async function openHeadlessTab(
  sessionId: string,
  url: string,
): Promise<WebContents> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  // The window must never flash up, whatever the page requests.
  win.setMenuBarVisibility(false);
  // Nor may its CHILDREN: a page's target=_blank or window.open() would
  // otherwise spawn a fully visible BrowserWindow over the user's screen —
  // the "она открыла на полную ширину" flash. Popups join the hidden layer.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openHeadlessTab(sessionId, url);
    return { action: "deny" };
  });
  const list = tabsOf(sessionId);
  list.push({ win });
  bySession.set(sessionId, list);
  console.log(`[headless] open ${sessionId.slice(0, 8)} ${url}`);
  win.on("closed", () => console.log(`[headless] closed ${sessionId.slice(0, 8)}`));
  await win.loadURL(url && url !== "about:blank" ? url : "about:blank").catch(() => {
    /* a failed load still leaves a drivable page (about:blank error page) */
  });
  return win.webContents;
}

/** The newest live hidden page of a session — what its tools drive. */
export function headlessContents(sessionId: string): WebContents | null {
  const list = tabsOf(sessionId);
  return list.length > 0 ? list[list.length - 1].win.webContents : null;
}

export function hasHeadless(sessionId: string): boolean {
  return tabsOf(sessionId).length > 0;
}

/** All hidden URLs of a session, for the desk that is about to show them. */
export function listHeadless(sessionId: string): string[] {
  return tabsOf(sessionId)
    .map((t) => t.win.webContents.getURL())
    .filter((u) => u && u !== "about:blank");
}

/**
 * Hand the hidden tabs over to the visible panel: return their URLs and
 * close them. The caller opens real tabs for these — two browsers holding
 * the same page would fight over it.
 */
export function adoptHeadless(sessionId: string): string[] {
  const urls = listHeadless(sessionId);
  console.log(`[headless] adopt ${sessionId.slice(0, 8)} -> ${urls.length} url(s)`);
  for (const t of tabsOf(sessionId)) {
    try {
      t.win.destroy();
    } catch {
      /* already gone */
    }
  }
  bySession.delete(sessionId);
  return urls;
}

/** Take a set of URLs INTO the hidden layer (the user just left this chat). */
export async function moveToHeadless(
  sessionId: string,
  urls: string[],
): Promise<void> {
  for (const url of urls) {
    if (!url || url === "about:blank") continue;
    await openHeadlessTab(sessionId, url);
  }
}

/** App shutdown: no hidden window may outlive the app. */
export function destroyAllHeadless(): void {
  for (const list of bySession.values()) {
    for (const t of list) {
      try {
        t.win.destroy();
      } catch {
        /* already gone */
      }
    }
  }
  bySession.clear();
}

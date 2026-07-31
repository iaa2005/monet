/**
 * Where a link in the app goes when you click it.
 *
 * Until now the answer was `<a target="_blank">`, and with no window-open
 * handler on the app window that opens a bare Electron window — no address
 * bar, no tabs, no way to tell what you are looking at. shell.ts says as much
 * in a comment and routes its own links around it; the ones the model writes
 * in chat went there anyway.
 *
 * Now they go to the Browser panel, where the agent can see the same page you
 * do. Ctrl/Cmd-click still hands it to your real browser — for signing in, or
 * for anything you would rather keep out of the workspace's cookie jar.
 */

import { useBrowserStore } from "@/components/browser/browser-store";
import type { ElectronAPI } from "@/types/electron";

const api = (): ElectronAPI | undefined =>
  (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;

/** True for the schemes the panel can actually show. */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface OpenLinkOptions {
  /** A modifier was held — send it to the OS browser instead. */
  external?: boolean;
}

/**
 * Open a link, in the panel or outside it.
 *
 * Anything that is not http(s) goes to the OS, which is the only thing that
 * knows what to do with a mailto: or a custom scheme — and the main-process
 * handler refuses those anyway.
 */
export function openLink(url: string, opts: OpenLinkOptions = {}): void {
  if (!url) return;
  const toPanel = useBrowserStore.getState().openLinksInPanel;
  if (!isWebLink(url) || opts.external || !toPanel) {
    void api()?.shell.openExternal(url);
    return;
  }
  useBrowserStore.getState().requestOpen(url);
}

/** Did this click ask for the OS browser? */
export function wantsExternal(e: {
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  return !!(e.ctrlKey || e.metaKey);
}

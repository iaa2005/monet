/**
 * The live <webview> element for each tab.
 *
 * The toolbar needs to call goBack()/reload()/loadURL() on a guest, and those
 * are imperative methods on a DOM node — not state. Passing the node up
 * through React would mean storing a DOM element in a store and re-rendering
 * the panel every time a tab attaches, for no gain.
 */

import type { WebviewTag } from "electron";

const views = new Map<string, WebviewTag>();

export function registerView(tabId: string, el: WebviewTag | null): void {
  if (el) views.set(tabId, el);
  else views.delete(tabId);
}

export function getView(tabId: string | null): WebviewTag | null {
  return tabId ? (views.get(tabId) ?? null) : null;
}

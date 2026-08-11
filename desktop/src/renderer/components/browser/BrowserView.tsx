/**
 * One tab's live page.
 *
 * Two rules this component exists to enforce:
 *
 * 1. An inactive tab is moved OFF-SCREEN, never `display: none`. Chromium stops
 *    compositing a hidden guest: screenshots come back blank and timers throttle,
 *    so a tab you switched away from would come back stale. A transform keeps
 *    the element laid out at the panel's real size, which also means the page
 *    never sees a 0×0 viewport and reflows to mobile behind your back.
 *
 * 2. `src` is written once, at mount, from a ref. It is an attribute, so React
 *    re-navigates the guest whenever the prop changes — which would undo the
 *    user's own back/forward the moment anything re-rendered. Every later
 *    navigation goes through loadURL(). Reading the CURRENT url at mount is
 *    also what makes a reopened panel land where you left it.
 */

import { useEffect, useRef } from "react";
import type { WebviewTag } from "electron";
import type { ElectronAPI } from "@/types/electron";
import { useBrowserStore, type BrowserTab } from "./browser-store";
import { registerView } from "./webview-registry";

const api = (): ElectronAPI =>
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

interface BrowserViewProps {
  tab: BrowserTab;
  partition: string;
  active: boolean;
}

/** Load cancelled by a newer navigation — normal, not a failure worth showing. */
const ERR_ABORTED = -3;

export function BrowserView({
  tab,
  partition,
  active,
}: BrowserViewProps): JSX.Element {
  // React ships its own <webview> typing (WebViewHTMLAttributes), so the JSX
  // ref is an HTMLWebViewElement — an empty interface that knows nothing about
  // goBack() or loadURL(). Electron's WebviewTag is the same DOM node with the
  // methods declared; the cast below is that one fact, stated once.
  const ref = useRef<HTMLWebViewElement>(null);
  const src = useRef(tab.url).current;

  useEffect(() => {
    const el = ref.current as WebviewTag | null;
    if (!el) return;
    registerView(tab.id, el);

    const patch = (p: Partial<BrowserTab>): void =>
      useBrowserStore.getState().patchTab(tab.id, p);

    // canGoBack/canGoForward are only meaningful once the guest is attached;
    // calling them earlier throws.
    const history = (): Partial<BrowserTab> => {
      try {
        return { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() };
      } catch {
        return {};
      }
    };

    const onStartLoading = (): void => patch({ loading: true, error: null });
    const onStopLoading = (): void => patch({ loading: false, ...history() });
    const onNavigate = (e: { url: string }): void =>
      patch({ url: e.url, error: null, ...history() });
    const onNavigateInPage = (e: { url: string; isMainFrame: boolean }): void => {
      if (e.isMainFrame) patch({ url: e.url, ...history() });
    };
    const onTitle = (e: { title: string }): void => patch({ title: e.title });
    const onFavicon = (e: { favicons: string[] }): void =>
      patch({ favicon: e.favicons[0] ?? null });
    const onFail = (e: {
      errorCode: number;
      errorDescription: string;
      isMainFrame: boolean;
    }): void => {
      if (!e.isMainFrame || e.errorCode === ERR_ABORTED) return;
      patch({
        loading: false,
        error: e.errorDescription || `Load failed (${e.errorCode})`,
      });
    };
    // The guest's webContents id is what lets main's tools drive this page.
    // Reported on every dom-ready, not just the first: a crashed guest comes
    // back with a new id, and a stale one is a tool acting on nothing.
    const onDomReady = (): void => {
      patch(history());
      try {
        void api().browser.registerTab(tab.id, el.getWebContentsId());
      } catch {
        /* guest went away between the event and the call */
      }
    };

    el.addEventListener("did-start-loading", onStartLoading);
    el.addEventListener("did-stop-loading", onStopLoading);
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigateInPage);
    el.addEventListener("page-title-updated", onTitle);
    el.addEventListener("page-favicon-updated", onFavicon);
    el.addEventListener("did-fail-load", onFail);
    el.addEventListener("dom-ready", onDomReady);

    return () => {
      el.removeEventListener("did-start-loading", onStartLoading);
      el.removeEventListener("did-stop-loading", onStopLoading);
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigateInPage);
      el.removeEventListener("page-title-updated", onTitle);
      el.removeEventListener("page-favicon-updated", onFavicon);
      el.removeEventListener("did-fail-load", onFail);
      el.removeEventListener("dom-ready", onDomReady);
      registerView(tab.id, null);
      void api().browser.unregisterTab(tab.id);
    };
  }, [tab.id]);

  // Which tab the tools act on follows which tab the user is looking at.
  useEffect(() => {
    if (active) void api().browser.activateTab(tab.id);
  }, [active, tab.id]);

  return (
    <div
      className="absolute inset-0"
      style={
        active
          ? undefined
          : // Off-screen, same size. See the note at the top of the file.
            { transform: "translateX(-200%)", pointerEvents: "none" }
      }
      aria-hidden={!active}
    >
      <webview
        ref={ref}
        src={src}
        partition={partition}
        // window.open must reach main's handler, which turns it into a tab in
        // our own strip instead of an OS window (see installWebviewGuards).
        //
        // THE STRING IS LOAD-BEARING, and the cast is the price of it.
        // `<webview allowpopups />` is a bare JSX boolean, and `webview` has no
        // dash in its name, so React treats it as an unknown HTML element
        // rather than a custom one and DROPS the attribute entirely — React
        // itself says so: "Received `true` for a non-boolean attribute
        // `allowpopups`… pass a string instead". Without the attribute on the
        // element, Chromium blocks every popup in the pane before any of our
        // code runs: window.open returns null, setWindowOpenHandler is never
        // consulted, and a sign-in button spins for ever with no window and no
        // error to show for it. That was the real reason Google sign-in "did
        // not open a window" — the disposition handler in main was correct all
        // along and simply unreachable. React's own DOM types insist this prop
        // is a boolean, which is precisely the value that does not survive, so
        // the string is cast past them.
        allowpopups={"true" as unknown as boolean}
        className="size-full"
      />
    </div>
  );
}

/**
 * The Browser panel: tab strip, address bar, and every live page.
 *
 * All tabs render at once — the inactive ones parked off-screen by BrowserView.
 * Unmounting them would be simpler and wrong: a tab is a running page with
 * scroll position, form state and a websocket, and switching tabs is not a
 * reason to throw those away.
 *
 * The partition comes from main rather than being derived here, because it
 * decides which logins survive; see main/browser/session.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  MoreVertical,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { BrowserPersist, ElectronAPI } from "@/types/electron";
import { BrowserView } from "./BrowserView";
import { BrowserEmptyState } from "./EmptyState";
import { useBrowserStore } from "./browser-store";
import { normalizeUrl } from "./url-input";
import { getView } from "./webview-registry";

const api = (): ElectronAPI =>
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

const BLANK = "about:blank";

export function BrowserPanel(): JSX.Element {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeId = useBrowserStore((s) => s.activeId);
  const layout = useBrowserStore((s) => s.layout);
  const partition = useBrowserStore((s) => s.partition);
  const workspaceVersion = useChatStore((s) => s.workspaceVersion);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  // Address bar: null means "show whatever the page is on"; a string means the
  // user is mid-edit and we must not yank the text out from under them.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openTab = useCallback((url?: string): void => {
    useBrowserStore.getState().openTab(url);
  }, []);

  // The partition is per workspace, so switching projects invalidates every
  // open tab: they hold the other project's cookies and would keep them.
  useEffect(() => {
    let cancelled = false;
    void api()
      .browser.partition()
      .then((next) => {
        if (cancelled) return;
        const store = useBrowserStore.getState();
        if (store.partition && store.partition !== next) {
          for (const t of store.tabs) store.closeTab(t.id);
        }
        store.setPartition(next);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceVersion]);

  const navigate = (raw: string): void => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setDraft(null);
    inputRef.current?.blur();
    if (!active) {
      openTab(url);
      return;
    }
    const view = getView(active.id);
    // Before dom-ready loadURL throws; the tab is brand new, so re-opening it
    // at the target is both correct and cheaper than waiting.
    if (view) void view.loadURL(url).catch(() => openTab(url));
    else openTab(url);
  };

  const act = (fn: (v: NonNullable<ReturnType<typeof getView>>) => void): void => {
    const view = getView(activeId);
    if (view) fn(view);
  };

  const setPersist = (mode: BrowserPersist): void => {
    void api()
      .browser.setConfig({ persistSessions: mode })
      .then(() =>
        api()
          .browser.partition()
          .then((next) => {
            const store = useBrowserStore.getState();
            for (const t of store.tabs) store.closeTab(t.id);
            store.setPartition(next);
          }),
      );
  };

  const clearData = (): void => {
    if (!partition) return;
    void api()
      .browser.clearData(partition)
      .then(() => act((v) => v.reload()));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => useBrowserStore.getState().selectTab(t.id)}
              className={cn(
                "group flex min-w-0 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                t.id === activeId
                  ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.loading ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : t.favicon ? (
                <img src={t.favicon} alt="" className="size-3 shrink-0" />
              ) : (
                <Globe className="size-3 shrink-0 opacity-60" />
              )}
              <span className="truncate">
                {t.title || (t.url === BLANK ? "New tab" : t.url)}
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  useBrowserStore.getState().closeTab(t.id);
                }}
                className="ml-auto shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="size-3" />
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => openTab()}
            aria-label="New tab"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Address bar */}
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
        <button
          type="button"
          onClick={() => act((v) => v.goBack())}
          disabled={!active?.canGoBack}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => act((v) => v.goForward())}
          disabled={!active?.canGoForward}
          aria-label="Forward"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => act((v) => (active?.loading ? v.stop() : v.reload()))}
          disabled={!active}
          aria-label={active?.loading ? "Stop" : "Reload"}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
        >
          {active?.loading ? (
            <X className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
        </button>

        <input
          ref={inputRef}
          value={draft ?? (active && active.url !== BLANK ? active.url : "")}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(e.currentTarget.value);
            if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          placeholder="Type a URL"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md bg-black/[0.04] px-2.5 py-1 text-xs outline-none placeholder:text-muted-foreground focus:bg-black/[0.06] dark:bg-white/[0.06] dark:focus:bg-white/[0.09]"
        />

        <button
          type="button"
          onClick={() => useBrowserStore.getState().toggleLayout()}
          aria-label={layout === "panel" ? "Expand" : "Collapse"}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          {layout === "panel" ? (
            <Maximize2 className="size-3.5" />
          ) : (
            <Minimize2 className="size-3.5" />
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Browser menu"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onClick={() => act((v) => v.openDevTools())}
              disabled={!active}
            >
              Open DevTools
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Persist sessions</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuItem onClick={() => setPersist("none")}>
                  <div>
                    <div>Don&apos;t keep</div>
                    <div className="text-xs text-muted-foreground">
                      Cleared when the app quits
                    </div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPersist("shared")}>
                  <div>
                    <div>Shared</div>
                    <div className="text-xs text-muted-foreground">
                      Same logins for every chat in this project
                    </div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPersist("perChat")}>
                  <div>
                    <div>Separate</div>
                    <div className="text-xs text-muted-foreground">
                      Each chat keeps its own
                    </div>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={clearData} disabled={!partition}>
              Clear cookies and cache
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
              {partition?.replace(/^persist:/, "") ?? "no session yet"}
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Pages */}
      <div className="relative min-h-0 flex-1 bg-white dark:bg-[#1b1b1c]">
        {partition &&
          tabs.map((t) => (
            <BrowserView
              key={t.id}
              tab={t}
              partition={partition}
              active={t.id === activeId}
            />
          ))}
        {tabs.length === 0 && <BrowserEmptyState onOpen={(u) => openTab(u)} />}
        {active?.error && (
          <div className="absolute inset-x-0 bottom-0 border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {active.error}
          </div>
        )}
      </div>
    </div>
  );
}

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
  Camera,
  Check,
  Code,
  Eraser,
  FolderOpen,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Minimize2,
  MoreVertical,
  MousePointerClick,
  Plus,
  RotateCw,
  Star,
  X,
} from "lucide-react";

/** What the trigger row shows for each mode. */
const PERSIST_LABEL: Record<BrowserPersist, string> = {
  none: "Don't keep",
  shared: "Shared",
  perChat: "Separate",
};
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
import { ServersMenu } from "./ServersMenu";
import { useBrowserStore } from "./browser-store";
import { normalizeUrl } from "./url-input";
import { getView } from "./webview-registry";

const api = (): ElectronAPI =>
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

const BLANK = "about:blank";

/**
 * The toolbar star: filled when the page it is looking at is bookmarked.
 *
 * State is re-read on every URL change and on the change broadcast, never
 * kept locally — the same page can be starred from the empty tab's Recent
 * list or un-starred in a second window, and a star that disagrees with the
 * list it feeds is worse than no star.
 */
function BookmarkStar({
  url,
  title,
}: {
  url: string | null;
  title: string;
}): JSX.Element {
  const [starred, setStarred] = useState(false);

  useEffect(() => {
    if (!url) {
      setStarred(false);
      return;
    }
    let gone = false;
    const check = (): void => {
      void api()
        .browser.bookmarks.isBookmarked(url)
        .then((v) => {
          if (!gone) setStarred(v);
        });
    };
    check();
    const off = api().browser.bookmarks.onChanged(check);
    return () => {
      gone = true;
      off();
    };
  }, [url]);

  return (
    <button
      type="button"
      disabled={!url}
      onClick={() => {
        if (url) void api().browser.bookmarks.toggle(url, title);
      }}
      title={starred ? "Remove bookmark" : "Bookmark this page"}
      aria-label={starred ? "Remove bookmark" : "Bookmark this page"}
      aria-pressed={starred}
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:hover:bg-transparent",
        starred
          ? "text-link hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
      )}
    >
      <Star className={cn("size-3.5", starred && "fill-current")} />
    </button>
  );
}

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
  const [designError, setDesignError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const designMode = useBrowserStore((s) => s.designMode);
  const openLinksInPanel = useBrowserStore((s) => s.openLinksInPanel);
  // The menu shows which mode is on, so it has to know — loaded once, then
  // kept by the handlers that change it.
  const [persistMode, setPersistMode] = useState<BrowserPersist>("shared");
  useEffect(() => {
    void api()
      .browser.getConfig()
      .then((c) => {
        setPersistMode(c.persistSessions);
        useBrowserStore.getState().setOpenLinksInPanel(c.openLinksInPanel);
      });
  }, []);

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

  // Design mode is a property of the PAGE, not of the panel: it lives in an
  // overlay injected into whatever document is loaded. So arming it again is
  // part of switching tabs, not something the store can remember for us.
  useEffect(() => {
    if (!designMode || !activeId) return;
    void api()
      .browser.setDesignMode(true)
      .then((r) => {
        if (!r.ok) {
          useBrowserStore.getState().setDesignMode(false);
          setDesignError(r.error ?? "Could not start design mode.");
        }
      });
  }, [designMode, activeId]);

  const toggleDesign = (): void => {
    const next = !designMode;
    setDesignError(null);
    useBrowserStore.getState().setDesignMode(next);
    // Turning it ON is left to the effect above, which also covers tab
    // switches. Turning it OFF has no such second trigger.
    if (!next) void api().browser.setDesignMode(false);
  };

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
    setPersistMode(mode);
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

  const toggleOpenLinks = (): void => {
    const next = !openLinksInPanel;
    useBrowserStore.getState().setOpenLinksInPanel(next);
    void api().browser.setConfig({ openLinksInPanel: next });
  };

  const openLocalFile = (): void => {
    void api()
      .browser.pickFile()
      .then((url) => {
        if (url) openTab(url);
      });
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

        <BookmarkStar url={active && active.url !== BLANK ? active.url : null} title={active?.title ?? ""} />

        <ServersMenu
          onOpen={(url) => {
            const view = getView(activeId);
            if (view && active) void view.loadURL(url).catch(() => openTab(url));
            else openTab(url);
          }}
        />

        <button
          type="button"
          onClick={toggleDesign}
          disabled={!active}
          title="Select elements on the page (Ctrl+Shift+D)"
          aria-label="Design mode"
          aria-pressed={designMode}
          className={cn(
            "flex size-6 items-center justify-center rounded-md transition-colors disabled:opacity-30",
            designMode
              ? "bg-link/15 text-link"
              : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
          )}
        >
          <MousePointerClick className="size-3.5" />
        </button>

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
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onClick={openLocalFile}>
              <FolderOpen className="size-4 shrink-0" />
              Open file
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!active}
              onClick={() =>
                void api()
                  .browser.saveScreenshot()
                  .then((r) => {
                    if (!r.ok && r.error) setDesignError(r.error);
                  })
              }
            >
              <Camera className="size-4 shrink-0" />
              Save screenshot
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                useChatStore.getState().requestOpenSettings("automation")
              }
            >
              <Hand className="size-4 shrink-0" />
              Manage allowed sites
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!active}
              onClick={() => act((v) => v.openDevTools())}
            >
              <Code className="size-4 shrink-0" />
              Open DevTools
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Toggles read as a row with a check on the right, like the
                official app's menu — a checkbox item, not a command. */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                toggleOpenLinks();
              }}
            >
              <span className="min-w-0 flex-1">Open links in Browser panel</span>
              {openLinksInPanel && <Check className="size-4 shrink-0 text-link" />}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1">Persist sessions</span>
                <span className="mr-1 text-xs text-muted-foreground">
                  {PERSIST_LABEL[persistMode]}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                {(
                  [
                    ["none", "Don't keep", "Cleared when the app quits"],
                    ["shared", "Shared", "Same data for every chat in this project"],
                    ["perChat", "Separate", "Each chat keeps its own"],
                  ] as const
                ).map(([value, label, hint]) => (
                  <DropdownMenuItem key={value} onClick={() => setPersist(value)}>
                    <span className="min-w-0 flex-1">
                      <span className="block">{label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </span>
                    {persistMode === value && (
                      <Check className="size-4 shrink-0 text-link" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem onClick={clearData} disabled={!partition}>
              <Eraser className="size-4 shrink-0" />
              Clear cookies and cache
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Pages */}
      <div className="relative min-h-0 flex-1 bg-transparent">
        {partition &&
          tabs.map((t) => (
            <BrowserView
              key={t.id}
              tab={t}
              partition={partition}
              active={t.id === activeId}
            />
          ))}
        {/* Shown for no tabs at all AND for a new (about:blank) tab — "the
            empty tab" is both, and a blank webview answers neither. */}
        {(tabs.length === 0 || active?.url === BLANK) && (
          <div className="absolute inset-0 bg-transparent">
            <BrowserEmptyState onOpen={(u) => navigate(u)} />
          </div>
        )}
        {designError && (
          <div className="absolute inset-x-0 top-0 border-b border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {designError}
          </div>
        )}
        {active?.error && (
          <div className="absolute inset-x-0 bottom-0 border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {active.error}
          </div>
        )}
      </div>
    </div>
  );
}

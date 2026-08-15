/**
 * The empty tab: servers, bookmarks, recent — one narrow column, left-aligned.
 *
 * The same row grammar as everything else in the app (dot/monogram + name +
 * detail), because the empty tab is a jump list, not a dashboard: the answer
 * to "what do I open" is almost always the dev server that is already running,
 * a page the user starred, or the page they just left. Width is capped so the
 * expanded panel does not stretch rows into ribbons.
 *
 * Bookmarks come from the toolbar star; the only affordance here is removal
 * and a small inline form for adding by URL, for the first-run case where
 * nothing has been starred yet.
 */

import { useEffect, useRef, useState } from "react";
import { Clock, Loader2, Play, Plus, Star, X } from "@/components/icons/hg";
import { chipColors, toneForLabel } from "@shared/selection-tones";
import type { Bookmark, ElectronAPI, ServerState, Visit } from "@/types/electron";
import { normalizeUrl } from "./url-input";

const api = (): ElectronAPI =>
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI;

interface EmptyStateProps {
  onOpen: (url: string) => void;
}

/** Track the app theme, so the monogram tints match the chips elsewhere. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() =>
      setDark(el.classList.contains("dark")),
    );
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return u.pathname.split("/").pop() || "file";
    return u.host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The little tinted square with a letter — the app's stand-in for favicons. */
function Monogram({ label, dark }: { label: string; dark: boolean }): JSX.Element {
  const c = chipColors(toneForLabel(label), dark);
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {(label[0] ?? "?").toUpperCase()}
    </span>
  );
}

function SectionHead({
  label,
  action,
}: {
  label: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="mb-1 flex items-center px-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

function timeAgo(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const ROW =
  "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]";

export function BrowserEmptyState({ onOpen }: EmptyStateProps): JSX.Element {
  const dark = useIsDark();
  const [servers, setServers] = useState<ServerState[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [recent, setRecent] = useState<Visit[]>([]);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bridge = api();
    const loadPages = (): void => {
      void bridge.browser.bookmarks.list().then(setBookmarks);
      void bridge.browser.bookmarks.recent(20).then(setRecent);
    };
    const loadServers = (): void => {
      void bridge.browser.servers.list().then(setServers);
    };
    loadPages();
    loadServers();
    const offPages = bridge.browser.bookmarks.onChanged(loadPages);
    const offServers = bridge.browser.servers.onChanged(loadServers);
    return () => {
      offPages();
      offServers();
    };
  }, []);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  // Already filtered against bookmarks on the main side — same-key logic.
  const shownRecent = recent.slice(0, 5);

  const addFromInput = (): void => {
    const url = normalizeUrl(addRef.current?.value ?? "");
    setAdding(false);
    if (!url) return;
    void api().browser.bookmarks.toggle(url, hostOf(url));
  };

  return (
    <div className="h-full overflow-y-auto grid">
      <div className="w-full max-w-[360px] space-y-6 px-4 py-6 m-auto">
        {servers.length > 0 && (
          <section>
            <SectionHead label="Servers" />
            {servers.map((s) => {
              const running = s.status === "running";
              const url = `http://localhost:${s.actualPort ?? s.port}/`;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    if (running) onOpen(url);
                    else if (s.status === "stopped" || s.status === "failed")
                      void api().browser.servers.start(s.id);
                  }}
                  title={running ? url : s.command}
                  className={ROW}
                >
                  <span
                    className={
                      running
                        ? "size-[7px] shrink-0 rounded-full bg-green-text shadow-[0_0_0_3px] shadow-green-bg"
                        : "size-[7px] shrink-0 rounded-full bg-muted-foreground/40"
                    }
                  />
                  <span className="text-xs font-semibold tabular-nums">
                    :{s.actualPort ?? s.port}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {s.name}
                    {!running && s.status !== "starting" && " — not running"}
                  </span>
                  {s.status === "starting" ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    !running && (
                      <Play className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    )
                  )}
                </button>
              );
            })}
          </section>
        )}

        <section>
          <SectionHead
            label="Bookmarks"
            action={
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                aria-label="Add bookmark"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              >
                <Plus className="size-3" />
              </button>
            }
          />
          {adding && (
            <input
              ref={addRef}
              placeholder="https://…"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") addFromInput();
                if (e.key === "Escape") setAdding(false);
              }}
              onBlur={() => setAdding(false)}
              className="mb-1 w-full rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground dark:bg-white/[0.06]"
            />
          )}
          {bookmarks.length === 0 && !adding ? (
            <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground">
              Star a page in the address bar to keep it here.
            </p>
          ) : (
            bookmarks.map((b) => (
              <div key={b.id} className={`${ROW} relative cursor-default`}>
                <button
                  type="button"
                  onClick={() => onOpen(b.url)}
                  title={b.url}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <Monogram label={b.title || hostOf(b.url)} dark={dark} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {b.title || hostOf(b.url)}
                    </span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">
                      {hostOf(b.url)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void api().browser.bookmarks.remove(b.id)}
                  aria-label="Remove bookmark"
                  className="absolute right-2 flex size-5 items-center justify-center rounded-md bg-accent text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))
          )}
        </section>

        {shownRecent.length > 0 && (
          <section>
            <SectionHead label="Recent" />
            {shownRecent.map((v) => (
              <div key={v.url + v.at} className={`${ROW} relative cursor-default`}>
                <button
                  type="button"
                  onClick={() => onOpen(v.url)}
                  title={v.url}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <Monogram label={v.title || hostOf(v.url)} dark={dark} />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {v.title || hostOf(v.url)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground group-hover:opacity-0">
                    <Clock className="size-2.5" />
                    {timeAgo(v.at)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void api().browser.bookmarks.toggle(
                      v.url,
                      v.title || hostOf(v.url),
                    )
                  }
                  aria-label="Bookmark this page"
                  title="Keep in bookmarks"
                  className="absolute right-2 flex size-5 items-center justify-center rounded-md bg-accent text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <Star className="size-3" />
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

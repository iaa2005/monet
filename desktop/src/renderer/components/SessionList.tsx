import { useState, useEffect, useRef, useMemo } from "react";
import {
  MoreVertical,
  Pin,
  Pencil,
  GitFork,
  Archive,
  Trash2,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExportChatModal } from "@/components/chat/ExportChatModal";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned?: boolean;
  archived?: boolean;
}

interface SessionListProps {
  onSelect: (session: {
    id: string;
    title: string;
    messages: ChatMessage[];
    workspace?: string;
  }) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  onFork?: (id: string) => void;
  currentSessionId?: string;
  /** Only show sessions from this space (home/code). */
  space?: string;
  filters?: {
    status: string;
    activity: string;
    group: string;
    sort: string;
    sortDir: string;
  };
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function SessionList({
  onSelect,
  onDelete,
  onRename,
  onFork,
  currentSessionId,
  space,
  filters,
}: SessionListProps): JSX.Element {
  const [allSessions, setAllSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [exportSession, setExportSession] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const version = useChatStore((s) => s.sessionsVersion);
  // Subscribe to the SET of running sessions as a string — subscribing to the
  // whole sessions map re-rendered the sidebar on every streaming flush.
  const runningKey = useChatStore((s) =>
    Object.entries(s.sessions)
      .filter(([, st]) => st.isStreaming)
      .map(([id]) => id)
      .sort()
      .join(","),
  );
  const runningIds = useMemo(
    () => new Set(runningKey ? runningKey.split(",") : []),
    [runningKey],
  );

  const loadSessions = async (): Promise<void> => {
    try {
      const status = filters?.status ?? "all";
      const sort = filters?.sort ?? "recency";
      const sortDir = filters?.sortDir ?? "desc";
      // "1d"/"3d"/"7d"/"30d" → a days window for the query; "all" → none.
      const activityDays =
        filters?.activity && filters.activity !== "all"
          ? Number.parseInt(filters.activity, 10) || undefined
          : undefined;
      const result = await api()?.sessions.list(
        50,
        0,
        space,
        status,
        sort,
        sortDir,
        activityDays,
      );
      if (result) setAllSessions(result as SessionSummary[]);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  // Keep a ref to the LATEST loader: the window-focus listener below is bound
  // once, and calling a stale closure reloaded the list with mount-time
  // space/filters — that's what emptied Recents after the workspace picker
  // dialog (or any focus loss) when the visible space had changed since mount.
  const loadRef = useRef(loadSessions);
  loadRef.current = loadSessions;

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    version,
    space,
    filters?.status,
    filters?.activity,
    filters?.sort,
    filters?.sortDir,
  ]);

  // "Group by" renders section headers between rows. Buckets are computed from
  // what's already loaded — grouping changes presentation, not the query.
  const grouped = useMemo((): { title: string; items: SessionSummary[] }[] => {
    const mode = filters?.group ?? "none";
    if (mode === "date") {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const buckets: [string, (d: Date) => boolean][] = [
        ["Today", (d) => d >= today],
        ["Yesterday", (d) => d >= new Date(today.getTime() - 86_400_000)],
        ["This week", (d) => d >= new Date(today.getTime() - 6 * 86_400_000)],
        ["This month", (d) => d >= new Date(today.getTime() - 29 * 86_400_000)],
        ["Older", () => true],
      ];
      const out = buckets.map(([title]) => ({
        title,
        items: [] as SessionSummary[],
      }));
      for (const s of allSessions) {
        const d = new Date(s.updatedAt);
        out[buckets.findIndex(([, test]) => test(d))].items.push(s);
      }
      return out.filter((g) => g.items.length > 0);
    }
    if (mode === "state") {
      const out = [
        { title: "Pinned", items: [] as SessionSummary[] },
        { title: "Active", items: [] as SessionSummary[] },
        { title: "Archived", items: [] as SessionSummary[] },
      ];
      for (const s of allSessions)
        out[s.pinned ? 0 : s.archived ? 2 : 1].items.push(s);
      return out.filter((g) => g.items.length > 0);
    }
    return [{ title: "", items: allSessions }];
  }, [allSessions, filters?.group]);

  const setArchived = async (id: string, v: boolean): Promise<void> => {
    setOpenMenuId(null);
    await api()?.sessions.setArchived(id, v);
    useChatStore.getState().bumpSessions();
  };
  const togglePin = async (id: string, pinned: boolean): Promise<void> => {
    setOpenMenuId(null);
    await api()?.sessions.setPinned(id, !pinned);
    useChatStore.getState().bumpSessions();
  };

  useEffect(() => {
    const onFocus = (): void => {
      loadRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenuId]);

  const handleSelect = async (id: string): Promise<void> => {
    try {
      const session = (await api()?.sessions.getById(id)) as
        | {
            id: string;
            title: string;
            messages: ChatMessage[];
            workspace?: string;
          }
        | null
        | undefined;
      if (session) {
        onSelect({
          id: session.id,
          title: session.title,
          messages: session.messages,
          workspace: session.workspace,
        });
      }
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  return (
    <div className="flex flex-col">
      {loading ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
      ) : allSessions.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          No recent chats
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 pb-2">
          {grouped.map((g) => (
            <div key={g.title || "all"} className="flex flex-col gap-0.5">
              {g.title && (
                <div className="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground/70">
                  {g.title}
                </div>
              )}
              {g.items.map((s) => {
            const active = s.id === currentSessionId;
            const menuOpen = openMenuId === s.id;
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
                  active && "bg-black/[0.06] dark:bg-white/[0.08]",
                )}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setOpenMenuId(menuOpen ? null : s.id);
                }}
              >
                <div
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onClick={() => handleSelect(s.id)}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      runningIds.has(s.id)
                        ? "animate-pulse bg-emerald-500"
                        : active
                          ? "bg-link"
                          : "bg-transparent",
                    )}
                    title={runningIds.has(s.id) ? "Running…" : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "flex items-center gap-1 truncate text-[13px]",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {s.pinned && (
                        <Pin className="size-3 shrink-0 text-muted-foreground/70" />
                      )}
                      {s.archived && (
                        <Archive
                          className="size-3 shrink-0 text-muted-foreground/70"
                          aria-label="Archived"
                        />
                      )}
                      <span className="truncate">
                        {s.title || "New session"}
                      </span>
                    </span>
                    {s.messageCount > 0 && (
                      <span className="block truncate text-[11px] text-muted-foreground/70">
                        {s.messageCount} msgs · {relTime(s.updatedAt)}
                      </span>
                    )}
                  </span>
                </div>

                {/* ⋮ button — visible on hover */}
                <button
                  type="button"
                  aria-label="More actions"
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-black/10 hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(menuOpen ? null : s.id);
                  }}
                >
                  <MoreVertical className="size-3" />
                </button>

                {/* Dropdown menu */}
                {menuOpen && (
                  <div
                    ref={menuRef}
                    className="absolute right-1 top-full z-50 mt-0.5 w-48 rounded-lg border border-border bg-card p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      onClick={() => togglePin(s.id, s.pinned ?? false)}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Pin className="size-4 text-muted-foreground" />
                      {s.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        onRename?.(s.id, s.title || "");
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Pencil className="size-4 text-muted-foreground" />
                      Rename
                      <span className="ml-auto text-xs text-muted-foreground">
                        R
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        onFork?.(s.id);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <GitFork className="size-4 text-muted-foreground" />
                      Fork
                      <span className="ml-auto text-xs text-muted-foreground">
                        F
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        setExportSession({ id: s.id, title: s.title });
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Download className="size-4 text-muted-foreground" />
                      Export…
                    </button>

                    <div className="-mx-1 my-1 h-px bg-border" />

                    <button
                      type="button"
                      onClick={() => setArchived(s.id, !s.archived)}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Archive className="size-4 text-muted-foreground" />
                      {s.archived ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        onDelete(s.id);
                        setAllSessions((prev) =>
                          prev.filter((x) => x.id !== s.id),
                        );
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 className="size-4" />
                      Delete
                      <span className="ml-auto text-xs opacity-70">D</span>
                    </button>
                  </div>
                )}
              </div>
            );
              })}
            </div>
          ))}
        </div>
      )}
      {exportSession && (
        <ExportChatModal
          sessionId={exportSession.id}
          title={exportSession.title}
          onClose={() => setExportSession(null)}
        />
      )}
    </div>
  );
}

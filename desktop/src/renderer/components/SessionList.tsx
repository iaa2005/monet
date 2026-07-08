import { useState, useEffect, useRef } from "react";
import {
  MoreVertical,
  Pin,
  BookOpen,
  Pencil,
  GitFork,
  Archive,
  Trash2,
  ExternalLink,
  Columns2,
  Monitor,
  Terminal as TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
}

interface SessionListProps {
  onSelect: (session: {
    id: string;
    title: string;
    messages: ChatMessage[];
  }) => void;
  onDelete: (id: string) => void;
  currentSessionId?: string;
  /** Only show sessions from this space (home/code). */
  space?: string;
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function SessionList({
  onSelect,
  onDelete,
  currentSessionId,
  space,
}: SessionListProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const version = useChatStore((s) => s.sessionsVersion);

  const loadSessions = async (): Promise<void> => {
    try {
      const result = await api()?.sessions.list(50, 0, space);
      if (result) setSessions(result as SessionSummary[]);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, space]);

  useEffect(() => {
    const onFocus = (): void => {
      loadSessions();
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
        | { id: string; title: string; messages: ChatMessage[] }
        | null
        | undefined;
      if (session) {
        onSelect({
          id: session.id,
          title: session.title,
          messages: session.messages,
        });
      }
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  if (loading) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        No recent chats
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {sessions.map((s) => {
        const active = s.id === currentSessionId;
        const menuOpen = openMenuId === s.id;
        return (
          <div
            key={s.id}
            className={cn(
              "group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
              active && "bg-black/[0.06] dark:bg-white/[0.08]",
            )}
          >
            <div
              className="flex min-w-0 flex-1 items-center gap-2"
              onClick={() => handleSelect(s.id)}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  active ? "bg-link" : "bg-transparent",
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[13px]",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.title || "New session"}
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
                {/* Open in submenu */}
                <div className="relative group/item">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  >
                    <ExternalLink className="size-4 text-muted-foreground" />
                    Open in
                    <span className="ml-auto text-xs text-muted-foreground">
                      ▸
                    </span>
                  </button>
                  <div className="absolute left-full top-0 z-50 ml-1 hidden w-44 rounded-lg border border-border bg-card p-1 shadow-lg group-hover/item:block">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Columns2 className="size-4 text-muted-foreground" />
                      Split view
                      <span className="ml-auto text-xs text-muted-foreground">
                        1
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <Monitor className="size-4 text-muted-foreground" />
                      New window
                      <span className="ml-auto text-xs text-muted-foreground">
                        2
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                      }}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      <TerminalIcon className="size-4 text-muted-foreground" />
                      Terminal
                      <span className="ml-auto text-xs text-muted-foreground">
                        3
                      </span>
                    </button>
                  </div>
                </div>

                <div className="-mx-1 my-1 h-px bg-border" />

                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Pin className="size-4 text-muted-foreground" />
                  Pin
                  <span className="ml-auto text-xs text-muted-foreground">
                    P
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <BookOpen className="size-4 text-muted-foreground" />
                  Mark as unread
                  <span className="ml-auto text-xs text-muted-foreground">
                    U
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
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
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <GitFork className="size-4 text-muted-foreground" />
                  Fork
                  <span className="ml-auto text-xs text-muted-foreground">
                    F
                  </span>
                </button>

                <div className="-mx-1 my-1 h-px bg-border" />

                <div className="relative group/item">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  >
                    <Archive className="size-4 text-muted-foreground" />
                    Move to group
                    <span className="ml-auto text-xs text-muted-foreground">
                      ▸
                    </span>
                  </button>
                  <div className="absolute left-full top-0 z-50 ml-1 hidden w-36 rounded-lg border border-border bg-card p-1 shadow-lg group-hover/item:block">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                      }}
                      className="flex w-full rounded-lg px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                      No groups yet
                    </button>
                  </div>
                </div>

                <div className="-mx-1 my-1 h-px bg-border" />

                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Archive className="size-4 text-muted-foreground" />
                  Archive
                  <span className="ml-auto text-xs text-muted-foreground">
                    A
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenuId(null);
                    onDelete(s.id);
                    setSessions((prev) => prev.filter((x) => x.id !== s.id));
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
  );
}

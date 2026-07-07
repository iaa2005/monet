import { useState, useEffect } from "react";
import { X } from "lucide-react";
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
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

export function SessionList({
  onSelect,
  onDelete,
  currentSessionId,
}: SessionListProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const version = useChatStore((s) => s.sessionsVersion);

  const loadSessions = async (): Promise<void> => {
    try {
      const result = await api()?.sessions.list(50, 0);
      if (result) setSessions(result as SessionSummary[]);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  // Reload whenever sessions change (new/save/delete) or the window regains focus.
  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    const onFocus = (): void => {
      loadSessions();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
        return (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={cn(
              "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]",
              active && "bg-black/[0.06] dark:bg-white/[0.08]",
            )}
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
            <button
              type="button"
              aria-label="Delete chat"
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-black/10 hover:text-foreground group-hover:opacity-100 dark:hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
                setSessions((prev) => prev.filter((x) => x.id !== s.id));
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

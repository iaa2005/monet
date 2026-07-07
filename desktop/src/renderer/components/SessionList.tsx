import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

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

  useEffect(() => {
    loadSessions();
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
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.title || "New session"}
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

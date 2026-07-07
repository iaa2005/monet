import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/chat";

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

export function SessionList({
  onSelect,
  onDelete,
  currentSessionId,
}: SessionListProps): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const loadSessions = async (query?: string): Promise<void> => {
    try {
      const api = window.electronAPI;
      const result = query
        ? await api.sessions.search(query)
        : await api.sessions.list(50, 0);
      setSessions(result);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (search) {
      loadSessions(search);
    } else {
      loadSessions();
    }
  }, [search]);

  const handleSelect = async (id: string): Promise<void> => {
    try {
      const api = window.electronAPI;
      const session = await api.sessions.getById(id);
      if (session) {
        onSelect({
          id: session.id,
          title: session.title,
          messages: session.messages as ChatMessage[],
        });
      }
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  const handleNew = async (): Promise<void> => {
    try {
      const api = window.electronAPI;
      const session = await api.sessions.create();
      onSelect({
        id: session.id,
        title: session.title,
        messages: [],
      });
      loadSessions();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <div className="flex h-full flex-col border-r bg-muted/30">
      <div className="border-b p-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Sessions</h2>
          <Button size="sm" variant="outline" onClick={handleNew}>
            + New
          </Button>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions..."
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="p-3 text-xs text-muted-foreground">Loading...</p>
        ) : sessions.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">No sessions yet</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={cn(
                "flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-accent/50",
                s.id === currentSessionId && "bg-accent",
              )}
              onClick={() => handleSelect(s.id)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.title}</p>
                <p className="text-xs text-muted-foreground">
                  {s.messageCount} msgs · {formatDate(s.updatedAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                  loadSessions();
                }}
              >
                ×
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

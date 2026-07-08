/**
 * Background tasks — a live registry of chats that are currently streaming.
 *
 * The chat store keeps per-session state keyed by sessionId, so a chat keeps
 * running even when it isn't the visible one (autonomous background chats).
 * This header control surfaces every session whose `isStreaming` is true,
 * lets you jump back to it, or stop it. The label is derived from the first
 * user message in the session's buffer, so it works for saved and incognito
 * chats alike without touching the DB.
 */

import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

function taskLabel(messages: ChatMessage[]): string {
  const firstUser = messages.find(
    (m) => m.role === "user" && m.content?.trim(),
  );
  const t = firstUser?.content?.trim();
  if (!t) return "Untitled chat";
  return t.length > 44 ? `${t.slice(0, 44)}…` : t;
}

interface BackgroundTasksProps {
  onOpen: (sessionId: string) => void;
  currentSessionId?: string;
}

export function BackgroundTasks({
  onOpen,
  currentSessionId,
}: BackgroundTasksProps): JSX.Element {
  const sessions = useChatStore((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const running = Object.entries(sessions).filter(([, st]) => st.isStreaming);
  const count = running.length;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Nothing left to show → collapse.
  useEffect(() => {
    if (open && count === 0) setOpen(false);
  }, [open, count]);

  return (
    <div ref={rootRef} className="app-no-drag relative">
      <button
        type="button"
        title={
          count
            ? `${count} running ${count === 1 ? "chat" : "chats"}`
            : "Background tasks"
        }
        aria-label="Background tasks"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex size-7 items-center justify-center rounded-md transition-colors",
          count
            ? "text-emerald-500 hover:bg-emerald-500/10"
            : "text-muted-foreground hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]",
        )}
      >
        <Activity className="size-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[14px] items-center justify-center rounded-full bg-emerald-500 px-[3px] text-[9px] font-semibold leading-[14px] text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-card p-1 shadow-lg">
          <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Background tasks
          </div>
          {count === 0 ? (
            <div className="px-2 py-3 text-center text-[13px] text-muted-foreground">
              No running chats
            </div>
          ) : (
            running.map(([id, st]) => {
              const isCurrent = id === currentSessionId;
              return (
                <div
                  key={id}
                  className="group/task flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" />
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(id);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[13px] text-foreground">
                      {taskLabel(st.messages)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {isCurrent ? "Viewing · running…" : "Running in background…"}
                    </div>
                  </button>
                  <button
                    type="button"
                    title="Stop"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api()?.chat.abort(id);
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover/task:opacity-100"
                  >
                    <Square className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

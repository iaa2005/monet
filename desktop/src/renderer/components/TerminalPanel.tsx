/**
 * The terminal panel: one chat, as many shells as you like.
 *
 * The shells live in main and outlive this component (terminal/sessions.ts),
 * so the panel's whole job is the LIST — which tabs this chat has, which one is
 * on screen, and the two buttons that add and remove them. On mount it asks
 * main what is already running rather than assuming: come back to a chat you
 * left with three terminals and you get three.
 *
 * Laid out like VS Code, because that is the habit people bring. The + sits at
 * the top-right of the terminal itself, not up in the dock's title bar next to
 * maximise — that row belongs to the panel, and a button for "another shell"
 * beside "detach panel" reads as a panel action. The tab list appears down the
 * right only once there are two: a sidebar listing one thing is furniture.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2, TerminalSquare } from "lucide-react";
import { Terminal } from "@/components/Terminal";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface Tab {
  id: string;
  title: string;
}

export function TerminalPanel({
  sessionId,
  space,
}: {
  sessionId: string;
  space: string;
}): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Guards the "open the first one" effect against React's double-mount in
  // dev: two runs would leave the chat with two shells before a click.
  const bootstrapped = useRef<string | null>(null);

  const openAnother = useCallback(async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const r = await api()?.sandbox.terminal.open(sessionId, space, 80, 24);
      if (!r?.ok || !r.id) {
        setError(r?.error ?? "Could not start a shell.");
        return;
      }
      const tab = { id: r.id, title: r.title ?? "shell" };
      setTabs((prev) => (prev.some((t) => t.id === tab.id) ? prev : [...prev, tab]));
      setActiveId(tab.id);
    } finally {
      setStarting(false);
    }
  }, [sessionId, space]);

  // What this chat already has. The shells are main's, so this is a question,
  // not an assumption — and it is asked again on every chat switch.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const existing = (await api()?.sandbox.terminal.list(sessionId)) ?? [];
      if (!alive) return;
      setTabs(existing);
      setActiveId(existing[0]?.id ?? null);
      if (existing.length === 0 && bootstrapped.current !== sessionId) {
        bootstrapped.current = sessionId;
        void openAnother();
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, openAnother]);

  // A shell that ends — `exit` at the prompt, or a crash — closes ITS tab and
  // nothing else. That is the whole reason exit needed handling: with one
  // terminal per chat there was no distinction to make.
  useEffect(() => {
    return api()?.sandbox.terminal.onExit((id) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        setActiveId((cur) => {
          if (cur !== id) return cur;
          // Land on the neighbour, the way a closed editor tab does.
          const i = prev.findIndex((t) => t.id === id);
          return next[Math.min(i, next.length - 1)]?.id ?? null;
        });
        return next;
      });
    });
  }, []);

  const closeTab = (id: string): void => {
    // Kills the shell; the exit event above does the list bookkeeping.
    void api()?.sandbox.terminal.close(id);
  };

  return (
    <div className="relative flex h-full min-h-0 w-full p-1 pt-0">
      <div className="relative min-w-0 flex-1">
        {activeId ? (
          // Keyed so switching tabs remounts against the other shell — the
          // scrollback is main's, and comes back with it.
          <Terminal key={activeId} terminalId={activeId} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-muted-foreground">
            {error ? (
              <span className="text-red-500">{error}</span>
            ) : (
              <button
                type="button"
                onClick={() => void openAnother()}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-medium transition-colors hover:bg-muted"
              >
                <Plus className="size-3.5" />
                New terminal
              </button>
            )}
          </div>
        )}

        {/* Top-right of the terminal, which is where the eye goes for "one
            more of these" — and out of the dock's own title row. */}
        {activeId && (
          <button
            type="button"
            title="New terminal"
            aria-label="New terminal"
            disabled={starting}
            onClick={() => void openAnother()}
            className="absolute right-2 top-2 flex size-6 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:opacity-50 dark:hover:bg-white/[0.08]"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>

      {/* Only once there is a choice to make. */}
      {tabs.length > 1 && (
        <div className="w-40 shrink-0 space-y-0.5 overflow-y-auto py-1 pl-1 pr-1 bg-muted/20 rounded-md">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={cn(
                "group flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px]",
                t.id === activeId
                  ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                  : "text-muted-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
              )}
            >
              <button
                type="button"
                onClick={() => setActiveId(t.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <TerminalSquare className="size-3.5 shrink-0" />
                <span className="truncate">{t.title}</span>
              </button>
              <button
                type="button"
                title="Kill terminal"
                aria-label="Kill terminal"
                onClick={() => closeTab(t.id)}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

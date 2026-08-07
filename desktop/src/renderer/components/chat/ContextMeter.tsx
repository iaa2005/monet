/**
 * Context-window meter: the token gauge in the composer, plus a click-through
 * popover that breaks the used context into categories (messages, system
 * prompt, tool schemas, MCP, skills, memory, free) with token counts and
 * percentages.
 *
 * The breakdown is estimated (chars/4) from the exact pieces the agent sends,
 * so it shows the *mix*, not an exact accounting. It is fetched on mount and
 * refreshed whenever the session or its usage changes, so the gauge persists
 * across chat switches and stays live through a session (never disappears).
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Gauge } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import type { ChatMessage } from "@/types/chat";
import type { ContextBreakdown, ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/** Rough token estimate of the VISIBLE messages (chars/4). Computed in the
 * renderer because it always has the loaded history — even for old chats the
 * main process never ran this session, which otherwise counted as 0. */
function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.toolCall) {
      chars += m.toolCall.name?.length ?? 0;
      chars += m.toolCall.output?.length ?? 0;
      try {
        chars += JSON.stringify(m.toolCall.input ?? {}).length;
      } catch {
        /* skip */
      }
    }
  }
  return Math.ceil(chars / 4);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Distinct, theme-neutral hues; free space is a muted grey.
const COLORS: Record<string, string> = {
  messages: "#3b82f6",
  system: "#8b5cf6",
  tools: "#0ea5e9",
  connectors: "#14b8a6",
  mcp: "#f59e0b",
  skills: "#10b981",
  memory: "#ec4899",
  overhead: "#94a3b8",
  free: "#cbd5e1",
};
const colorOf = (key: string): string => COLORS[key] ?? "#94a3b8";


export function ContextMeter({
  sessionId,
  space,
  usedTokens,
  ctxWindow,
  className
}: {
  sessionId: string | null;
  space: string;
  usedTokens: number;
  ctxWindow: number;
  className?: string;
}): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const msgTokens = useMemo(() => estimateMessageTokens(messages), [messages]);
  const [data, setData] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [compactions, setCompactions] = useState<
    { id: string; at: string; beforeTokens: number | null; afterTokens: number | null }[]
  >([]);
  const [refreshKey, setRefreshKey] = useState(0);
  /** Prompts still in the model's context (not bubbles on screen). */
  const [undoable, setUndoable] = useState(0);
  /** How many this session's user has taken back, for the confirmation line. */
  const [undone, setUndone] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Collapse all categories by default when new breakdown data arrives.
  useEffect(() => {
    if (!data) return;
    setCollapsed(new Set(data.categories.map((c) => c.key)));
  }, [data]);

  // Drop the previous chat's breakdown the instant the session changes, so a
  // new/old chat never shows the last chat's numbers while the refetch runs.
  useEffect(() => {
    setData(null);
    setCompactions([]);
    setCollapsed(new Set());
    setUndone(0);
    setUndoable(0);
  }, [sessionId]);

  // How many prompts the model still reads, and how many were taken out —
  // counted from the transcript's own flags rather than reconstructed by
  // replaying past operations. Both numbers come from one list, so they
  // cannot disagree with each other or with the chat.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const turns = await api()?.chat.turnContext(sessionId ?? "default");
      if (cancelled || !turns) return;
      setUndoable(turns.filter((t) => t.inContext).length);
      setUndone(turns.filter((t) => !t.inContext).length);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, msgTokens, refreshKey]);

  // Compaction history for this chat — powers "rewind through compact".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const evs = await api()?.chat.contextEvents(sessionId ?? "default");
      if (cancelled || !evs) return;
      setCompactions(
        evs
          .filter((e) => e.type === "compact")
          .map((e) => ({
            id: e.id,
            at: e.at,
            beforeTokens: e.beforeTokens,
            afterTokens: e.afterTokens,
          })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, msgTokens, refreshKey]);

  const undoCompact = async (id: string): Promise<void> => {
    await api()?.chat.undoCompact(sessionId ?? "default", id);
    setRefreshKey((k) => k + 1);
  };

  /**
   * Take the last prompt back out of the model's context.
   *
   * Note what this does NOT do: revert files. That is the checkpoint rewind,
   * and conflating the two would be the worst kind of surprise — the tooltip
   * says so, and the count shown is what is actually still in context, which
   * is smaller than the number of bubbles on screen once a compaction has
   * folded the earlier ones into a summary.
   */
  const undoPrompt = async (): Promise<void> => {
    const r = await api()?.chat.undoPrompts(sessionId ?? "default", 1);
    if (!r) return;
    setUndone((n) => n + r.removed);
    setRefreshKey((k) => k + 1);
    // The transcript on screen did not change — only what the model can read
    // did. Without this the chat keeps drawing the old map.
    useChatStore.getState().bumpContext();
  };

  // Recompute whenever the session, space, or the visible message tokens change
  // (message tokens move on every turn AND on chat switches), passing the
  // renderer's own message estimate so old chats count correctly.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await api()?.chat.contextBreakdown(
          sessionId ?? "default",
          space,
          msgTokens,
        );
        if (!cancelled && r) setData(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, space, msgTokens]);

  const budget = data?.budget ?? ctxWindow;
  // The breakdown total (accurate) once loaded; before that a light fallback.
  const used = data?.used ?? Math.max(usedTokens, msgTokens);
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const pctOf = (n: number): number => (budget > 0 ? (n / budget) * 100 : 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={className}
          title="Context window — click for a breakdown"
        >
          <Gauge className="size-3" />
          {fmt(used)} · {pct}%
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-80 p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Context window</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {fmt(used)} / {fmt(budget)} ({pct}%)
          </span>
        </div>

        {/* Stacked usage bar (free space fills the remainder). */}
        <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {data?.categories.map((c) =>
            c.tokens > 0 ? (
              <div
                key={c.key}
                style={{
                  width: `${pctOf(c.tokens)}%`,
                  background: colorOf(c.key),
                }}
                title={`${c.label}: ${fmt(c.tokens)}`}
              />
            ) : null,
          )}
        </div>

        {loading && !data ? (
          <div className="py-1 text-xs text-muted-foreground">Calculating…</div>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {data?.categories.map((c) => {
              const items = c.items ?? [];
              const hasItems = items.length > 0;
              return (
                <div key={c.key}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-xs"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.key)) next.delete(c.key);
                        else next.add(c.key);
                        return next;
                      })
                    }
                  >
                    {hasItems ? (
                      collapsed.has(c.key) ? (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <ChevronRight className="size-3 shrink-0 opacity-0" />
                    )}
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: colorOf(c.key) }}
                    />
                    <span className="flex-1 truncate text-left text-foreground">
                      {c.label}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {fmt(c.tokens)}
                    </span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">
                      {pctOf(c.tokens).toFixed(1)}%
                    </span>
                  </button>
                  {hasItems && !collapsed.has(c.key) && (
                    <div className="mt-0.5 ml-[18px] space-y-0.5 border-l border-border pl-2">
                      {items.map((it) => (
                        <div
                          key={it.label}
                          className="flex items-center gap-2 text-[10px] text-muted-foreground"
                        >
                          <span className="flex-1 truncate">{it.label}</span>
                          <span className="tabular-nums">{fmt(it.tokens)}</span>
                          <span className="w-12 text-right tabular-nums">
                            {pctOf(it.tokens).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {undoable > 0 && (
          <div className="mt-2.5 border-t border-border pt-2">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 text-muted-foreground">
                {/* Both numbers, when any prompt is out: "how much is
                    gone" and "how much is left" answer different
                    questions, and showing only the first hid the second. */}
                {undone > 0
                  ? `${undone} prompt${undone === 1 ? "" : "s"} removed · ${undoable} still in context`
                  : `${undoable} prompt${undoable === 1 ? "" : "s"} in context`}
              </span>
              <button
                type="button"
                onClick={() => void undoPrompt()}
                className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                title="Drop the last prompt and its reply from the model's context. Files are NOT reverted — use Rewind for that."
              >
                Undo last prompt
              </button>
            </div>
          </div>
        )}

        {compactions.length > 0 && (
          <div className="mt-2.5 border-t border-border pt-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Compactions
            </div>
            <div className="space-y-1">
              {compactions.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span className="flex-1 truncate text-muted-foreground">
                    {c.beforeTokens != null && c.afterTokens != null
                      ? `${fmt(c.beforeTokens)} → ${fmt(c.afterTokens)}`
                      : "compacted"}
                    <span className="ml-1 opacity-60">
                      {new Date(c.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void undoCompact(c.id)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    title="Restore the pre-compaction context (rewind through compact)"
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2.5 border-t border-border pt-2 text-[10px] leading-snug text-muted-foreground">
          {data?.apiUsage ? (
            <>
              Total is <span className="font-medium">measured</span> from the
              last API response ({fmt(data.apiUsage.input_tokens)} in
              {data.apiUsage.cache_read_input_tokens > 0
                ? ` · ${fmt(data.apiUsage.cache_read_input_tokens)} cached`
                : ""}
              ). The per-category split is estimated (~chars/4).
            </>
          ) : (
            <>
              Estimated (~chars/4) from the system prompt, tool schemas, skills,
              memory and conversation. The point is the mix, not exact
              accounting.
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

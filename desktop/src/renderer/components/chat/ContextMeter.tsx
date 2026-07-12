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
import { Gauge } from "lucide-react";
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
  mcp: "#f59e0b",
  skills: "#10b981",
  memory: "#ec4899",
  overhead: "#94a3b8",
  free: "#cbd5e1",
};
const colorOf = (key: string): string => COLORS[key] ?? "#94a3b8";

/** Max drill-down rows shown per category before collapsing into "+N more". */
const MAX_ITEMS = 6;

export function ContextMeter({
  sessionId,
  space,
  usedTokens,
  ctxWindow,
}: {
  sessionId: string | null;
  space: string;
  usedTokens: number;
  ctxWindow: number;
}): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const msgTokens = useMemo(() => estimateMessageTokens(messages), [messages]);
  const [data, setData] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  // Drop the previous chat's breakdown the instant the session changes, so a
  // new/old chat never shows the last chat's numbers while the refetch runs.
  useEffect(() => {
    setData(null);
  }, [sessionId]);

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
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
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
          <div className="space-y-1.5">
            {data?.categories.map((c) => {
              const items = c.items ?? [];
              const shown = items.slice(0, MAX_ITEMS);
              const restTokens = items
                .slice(MAX_ITEMS)
                .reduce((n, it) => n + it.tokens, 0);
              return (
                <div key={c.key}>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: colorOf(c.key) }}
                    />
                    <span className="flex-1 truncate text-foreground">
                      {c.label}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {fmt(c.tokens)}
                    </span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">
                      {pctOf(c.tokens).toFixed(1)}%
                    </span>
                  </div>
                  {shown.length > 0 && (
                    <div className="mt-0.5 ml-[18px] space-y-0.5 border-l border-border pl-2">
                      {shown.map((it) => (
                        <div
                          key={it.label}
                          className="flex items-center gap-2 text-[10px] text-muted-foreground"
                        >
                          <span className="flex-1 truncate">{it.label}</span>
                          <span className="tabular-nums">{fmt(it.tokens)}</span>
                        </div>
                      ))}
                      {items.length > MAX_ITEMS && (
                        <div className="flex items-center gap-2 text-[10px] italic text-muted-foreground/70">
                          <span className="flex-1 truncate">
                            +{items.length - MAX_ITEMS} more
                          </span>
                          <span className="tabular-nums">
                            {fmt(restTokens)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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

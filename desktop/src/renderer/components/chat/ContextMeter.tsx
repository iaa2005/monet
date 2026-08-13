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
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "@/stores/chatStore";
import type { ContextBreakdown, ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

/*
 * There is no estimate here any more, and that is the fix.
 *
 * This counted the VISIBLE messages — tool inputs and outputs included — and the
 * main process preferred it over its own, on the reasoning that the renderer
 * always has the loaded history. What it always has is the DISPLAY history, and
 * compaction does not touch that: it truncates the model-facing transcript.
 *
 * So a chat reported 537,000 tokens while the model was being sent 2,764, and a
 * manual compaction that genuinely ran (3,405 → 2,764, recorded in
 * context_events) left the number exactly where it was. Which reads, correctly,
 * as "compaction does nothing".
 *
 * The number now comes from the transcript alone, which is the thing that is
 * sent, the thing compaction shrinks, and the thing you are billed for.
 */

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

/**
 * The gauge itself: a ring that fills as the window does.
 *
 * A number needs reading; a ring is read at a glance, which is all this
 * control is for — the figures live one click away in the breakdown. The
 * colour is the whole message: brand while there is room, amber past 70%,
 * destructive past 90%. Those two thresholds are the only thing to change if
 * the warning should come earlier.
 */
const WARN_AT = 70;
const DANGER_AT = 90;

function UsageRing({ pct }: { pct: number }): JSX.Element {
  const r = 5.5;
  const circumference = 2 * Math.PI * r;
  const tone =
    pct >= DANGER_AT
      ? "var(--destructive)"
      : pct >= WARN_AT
        ? "var(--warn)"
        : "hsl(var(--brand))";
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" aria-hidden>
      {/* The track is currentColor, so it sits at whatever weight the row
          around it has instead of needing a colour of its own. */}
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, pct)) / 100)}
        transform="rotate(-90 7 7)"
        style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
      />
    </svg>
  );
}


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
  // Refetch when the conversation grows — the count, not an estimate of it.
  const msgCount = messages.length;
  const [data, setData] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [compactions, setCompactions] = useState<
    { id: string; at: string; beforeTokens: number | null; afterTokens: number | null }[]
  >([]);
  const [refreshKey, setRefreshKey] = useState(0);
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
  }, [sessionId]);

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
  }, [sessionId, msgCount, refreshKey]);

  const undoCompact = async (id: string): Promise<void> => {
    await api()?.chat.undoCompact(sessionId ?? "default", id);
    setRefreshKey((k) => k + 1);
  };

  // Recompute when the session or space changes, and when the conversation grows
  // — a turn is what moves the context. The main process answers from the
  // transcript; nothing about the display history is passed to it.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await api()?.chat.contextBreakdown(
          sessionId ?? "default",
          space,
        );
        if (!cancelled && r) setData(r);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, space, msgCount]);

  const budget = data?.budget ?? ctxWindow;
  // The breakdown total (accurate) once loaded; before that a light fallback.
  const used = data?.used ?? usedTokens;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const pctOf = (n: number): number => (budget > 0 ? (n / budget) * 100 : 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={className}
          title={`Context window — ${fmt(used)} / ${fmt(budget)} (${pct}%). Click for a breakdown.`}
        >
          <UsageRing pct={pct} />
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

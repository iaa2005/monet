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
import { Gauge } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import type { ContextBreakdown, ElectronAPI } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
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
  free: "#cbd5e1",
};
const colorOf = (key: string): string => COLORS[key] ?? "#94a3b8";

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
  const [data, setData] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  // Refresh on session/space change and after each turn (usedTokens moves), so
  // the gauge tracks the live session and survives chat switches.
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
  }, [sessionId, space, usedTokens]);

  const budget = data?.budget ?? ctxWindow;
  // Prefer the real API usage when we have it; otherwise the estimate.
  const used = Math.max(usedTokens, data?.used ?? 0);
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
            {data?.categories.map((c) => (
              <div key={c.key} className="flex items-center gap-2 text-xs">
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
            ))}
          </div>
        )}

        <div className="mt-2.5 border-t border-border pt-2 text-[10px] leading-snug text-muted-foreground">
          Estimated (~chars/4) from the system prompt, tool schemas, skills,
          memory and conversation. The point is the mix, not exact accounting.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { ElectronAPI } from "@/types/electron";

interface Stats {
  sessions: number;
  messages: number;
  userMessages: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  approxTokens: number;
  perDay: { date: string; count: number }[];
}

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

const RANGES = [
  { id: 0, label: "All" },
  { id: 30, label: "30d" },
  { id: 7, label: "7d" },
];

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtHour(h: number | null): string {
  if (h == null) return "—";
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${ap}`;
}

export function StatsDashboard(): JSX.Element {
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [range, setRange] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [model, setModel] = useState("—");

  useEffect(() => {
    api()
      ?.stats.get(range || undefined)
      .then((s) => setStats(s as Stats))
      .catch(() => {});
  }, [range]);

  useEffect(() => {
    api()
      ?.providers.getActive()
      .then((p) => {
        const prov = p as { model?: string } | undefined;
        if (prov?.model) setModel(prov.model);
      })
      .catch(() => {});
  }, []);

  const cards = stats
    ? [
        { label: "Sessions", value: fmtNum(stats.sessions) },
        { label: "Current streak", value: `${stats.currentStreak}d` },
        { label: "Messages", value: fmtNum(stats.messages) },
        { label: "Longest streak", value: `${stats.longestStreak}d` },
        { label: "Total tokens", value: `~${fmtNum(stats.approxTokens)}` },
        { label: "Peak hour", value: fmtHour(stats.peakHour) },
        { label: "Active days", value: fmtNum(stats.activeDays) },
        { label: "Favorite model", value: model },
      ]
    : [];

  const recent = stats ? stats.perDay.slice(-30) : [];
  const maxDay = Math.max(1, ...recent.map((d) => d.count));

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex gap-1">
          {(["overview", "models"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors",
                tab === t
                  ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs transition-colors",
                range === r.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <div
              key={c.label}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="truncate text-2xl font-semibold">{c.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {c.label}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 text-sm font-medium">Activity by day</div>
          {recent.length > 0 ? (
            <div className="flex h-40 items-end gap-1">
              {recent.map((d) => (
                <div
                  key={d.date}
                  className="flex h-full flex-1 items-end"
                  title={`${d.date}: ${d.count} messages`}
                >
                  <div
                    className="w-full rounded-t bg-brand/70"
                    style={{
                      height: `${Math.max(3, (d.count / maxDay) * 100)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No activity yet.
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Active model: {model}. A per-model breakdown will appear once model
            usage is recorded per message.
          </p>
        </div>
      )}
    </div>
  );
}

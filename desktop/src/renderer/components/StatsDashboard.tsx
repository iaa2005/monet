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

// The Great Gatsby ≈ 47k words ≈ this many tokens — the yardstick the official
// overview uses for its "N× more tokens" flourish.
const GATSBY_TOKENS = 62_000;

const HEATMAP_WEEKS = 16;

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtHour(h: number | null): string {
  if (h == null) return "—";
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${ap}`;
}

/** Local YYYY-MM-DD — must match the backend's localDay() so counts line up. */
function localDayStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * GitHub-style grid: columns = weeks, rows = weekdays (Sun→Sat). The LAST
 * column is the current week, so today and recent activity always land inside
 * the window.
 */
function buildColumns(
  perDay: { date: string; count: number }[],
): { date: string; count: number; future: boolean }[][] {
  const counts = new Map(perDay.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = localDayStr(today);

  // Sunday of the current week = start of the last column.
  const lastSunday = new Date(today);
  lastSunday.setDate(lastSunday.getDate() - lastSunday.getDay());
  const cursor = new Date(lastSunday);
  cursor.setDate(cursor.getDate() - (HEATMAP_WEEKS - 1) * 7);

  const columns: { date: string; count: number; future: boolean }[][] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const col: { date: string; count: number; future: boolean }[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const ds = localDayStr(cursor);
      col.push({ date: ds, count: counts.get(ds) ?? 0, future: ds > todayStr });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(col);
  }
  return columns;
}

function cellClass(count: number, max: number, future: boolean): string {
  if (future) return "bg-transparent";
  if (count <= 0) return "bg-black/[0.06] dark:bg-white/[0.08]";
  const q = count / Math.max(1, max);
  if (q > 0.75) return "bg-sky-600 dark:bg-sky-500";
  if (q > 0.5) return "bg-sky-500/80 dark:bg-sky-500/70";
  if (q > 0.25) return "bg-sky-500/55 dark:bg-sky-500/45";
  return "bg-sky-500/30 dark:bg-sky-500/25";
}

function Heatmap({
  perDay,
}: {
  perDay: { date: string; count: number }[];
}): JSX.Element {
  const columns = buildColumns(perDay);
  const max = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <div className="flex gap-0.5 max-w-xs">
      {columns.map((col, ci) => (
        <div key={ci} className="flex flex-1 flex-col gap-0.5">
          {col.map((cell) => (
            <div
              key={cell.date}
              title={cell.future ? "" : `${cell.date}: ${cell.count} messages`}
              className={cn(
                "aspect-square rounded-[3px]",
                cellClass(cell.count, max, cell.future),
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
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

  // Two rows, matching the official overview layout & order.
  const cards = stats
    ? [
        { label: "Sessions", value: fmtNum(stats.sessions) },
        { label: "Messages", value: fmtNum(stats.messages) },
        { label: "Total tokens", value: fmtNum(stats.approxTokens) },
        { label: "Active days", value: fmtNum(stats.activeDays) },
        { label: "Current streak", value: `${stats.currentStreak}d` },
        { label: "Longest streak", value: `${stats.longestStreak}d` },
        { label: "Peak hour", value: fmtHour(stats.peakHour) },
        { label: "Favorite model", value: model },
      ]
    : [];

  const gatsby = stats ? Math.round(stats.approxTokens / GATSBY_TOKENS) : 0;

  const recent = stats ? stats.perDay.slice(-30) : [];
  const maxDay = Math.max(1, ...recent.map((d) => d.count));

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="rounded-2xl bg-black/[0.025] p-5 dark:bg-white/[0.04]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-1">
            {(["overview", "models"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm font-medium capitalize transition-colors",
                  tab === t
                    ? "bg-black/[0.06] text-foreground dark:bg-white/[0.1]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
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
          <>
            <div className="grid grid-cols-4 gap-2">
              {cards.map((c) => (
                <div
                  key={c.label}
                  className="rounded-md bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.06]"
                >
                  <div className="truncate text-xs text-muted-foreground">
                    {c.label}
                  </div>
                  <div
                    className="mt-1 truncate text-lg font-semibold leading-tight"
                    title={c.value}
                  >
                    {c.value}
                  </div>
                </div>
              ))}
            </div>

            {stats && (
              <div className="mt-4">
                <Heatmap perDay={stats.perDay} />
                {gatsby >= 1 && stats.approxTokens > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    You&apos;ve used ~{fmtNum(gatsby)}× more tokens than The
                    Great Gatsby.
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <div>
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
                      className="w-full rounded-t bg-sky-500/70"
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
              Active model: {model}. A per-model breakdown will appear once
              model usage is recorded per message.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

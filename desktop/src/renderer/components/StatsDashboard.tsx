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

const HEATMAP_COLS = 52;
const HEATMAP_ROWS = 7;

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
 * GitHub-style grid: columns = weeks, rows = weekdays (Mon→Sun). The LAST
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

  // Monday of the current week = start of the last column.
  const lastMonday = new Date(today);
  lastMonday.setDate(lastMonday.getDate() - ((lastMonday.getDay() + 6) % 7));
  const cursor = new Date(lastMonday);
  cursor.setDate(cursor.getDate() - (HEATMAP_COLS - 1) * 7);

  const columns: { date: string; count: number; future: boolean }[][] = [];
  for (let w = 0; w < HEATMAP_COLS; w++) {
    const col: { date: string; count: number; future: boolean }[] = [];
    for (let dow = 0; dow < HEATMAP_ROWS; dow++) {
      const ds = localDayStr(cursor);
      col.push({ date: ds, count: counts.get(ds) ?? 0, future: ds > todayStr });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(col);
  }
  return columns;
}

const SHOW_PAINTING = false; // set to true to reveal the full painting at 100% opacity

function cellStyle(
  count: number,
  max: number,
  future: boolean,
  pixelColor: string | null,
): React.CSSProperties {
  const color = pixelColor ?? "#0ea5e9";
  if (SHOW_PAINTING) return { backgroundColor: color, opacity: 1 };
  if (future) return { background: "transparent" };
  const q = count <= 0 ? 0 : count / Math.max(1, max);
  const opacity = count <= 0 ? 0.06 : 0.25 + q * 0.75;
  return { backgroundColor: color, opacity };
}

function Heatmap({
  perDay,
  pixels,
}: {
  perDay: { date: string; count: number }[];
  pixels: string[] | null;
}): JSX.Element {
  const columns = buildColumns(perDay);
  const max = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <div className="flex gap-1 w-full">
      {columns.map((col, ci) => (
        <div key={ci} className="flex flex-1 flex-col gap-1">
          {col.map((cell, dow) => {
            const color = pixels?.[dow * HEATMAP_COLS + ci] ?? null;
            return (
              <div
                key={cell.date}
                title={cell.future ? "" : `${cell.date}: ${cell.count} messages`}
                className="w-full rounded-[2px]"
                style={{
                  ...cellStyle(cell.count, max, cell.future, color),
                  aspectRatio: "1/3",
                }}
              />
            );
          })}
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
  const [paintingPixels, setPaintingPixels] = useState<string[] | null>(null);
  const [paintingTitle, setPaintingTitle] = useState<string | null>(null);

  // ── Load a random horizontal Monet painting & extract pixels ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          "https://raw.githubusercontent.com/iaa2005/monet-paintings/main/monet_paintings.json",
        );
        const data: { title: string; filename: string; aspect_ratio: number }[] =
          await res.json();
        const horizontals = data.filter((p) => p.aspect_ratio >= 1.67);
        if (horizontals.length === 0) return;
        const pick = horizontals[Math.floor(Math.random() * horizontals.length)];

        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject();
          img.src = `https://raw.githubusercontent.com/iaa2005/monet-paintings/main/${pick.filename}`;
        });
        if (cancelled) return;

        // Resize + crop to HEATMAP_COLS × HEATMAP_ROWS
        const canvas = document.createElement("canvas");
        canvas.width = HEATMAP_COLS;
        canvas.height = HEATMAP_ROWS;
        const ctx = canvas.getContext("2d")!;
        const targetAspect = HEATMAP_COLS / HEATMAP_ROWS;
        const srcAspect = img.naturalWidth / img.naturalHeight;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (srcAspect > targetAspect) {
          sw = img.naturalHeight * targetAspect;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = img.naturalWidth / targetAspect;
          sy = (img.naturalHeight - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, HEATMAP_COLS, HEATMAP_ROWS);

        const pixels: string[] = [];
        for (let y = 0; y < HEATMAP_ROWS; y++) {
          for (let x = 0; x < HEATMAP_COLS; x++) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            pixels.push(`rgb(${r},${g},${b})`);
          }
        }
        if (!cancelled) {
          setPaintingPixels(pixels);
          setPaintingTitle(pick.title);
        }
      } catch {
        // Fall back to default sky-blue colors.
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Fill the full date window so the bar chart always has the right column count.
  const recentDays = range === 0 ? 365 : range;
  const recent = (() => {
    if (!stats) return [];
    const counts = new Map(stats.perDay.map((d) => [d.date, d.count]));
    const result: { date: string; count: number }[] = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    for (let i = recentDays - 1; i >= 0; i--) {
      const d = new Date(cursor);
      d.setDate(d.getDate() - i);
      const ds = localDayStr(d);
      result.push({ date: ds, count: counts.get(ds) ?? 0 });
    }
    return result;
  })();
  const maxDay = Math.max(1, ...recent.map((d) => d.count));

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="glass-panel rounded-lg bg-card p-4 border border-border">
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
          <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
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
                  className="rounded-md bg-muted px-3 py-2.5"
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
                <Heatmap perDay={stats.perDay} pixels={paintingPixels} />
                {paintingTitle && (
                  <p className="mt-1 text-[10px] text-muted-foreground/50">
                    Activity painted with «{paintingTitle}» by Claude Monet
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <div>
            <div className="mb-3 text-sm font-medium">Activity by day</div>
            {recent.length > 0 ? (
              <div className="flex h-40 items-end gap-px">
                {recent.map((d) => (
                  <div
                    key={d.date}
                    className="flex h-full flex-1 items-end"
                    title={`${d.date}: ${d.count} messages`}
                  >
                    <div
                      className={cn(
                        "w-full bg-sky-500/70",
                        recentDays <= 30 && "rounded-t",
                      )}
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

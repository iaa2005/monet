/**
 * Settings → Reflect — a Claude.ai-style monthly digest: serif headline +
 * narrative (LLM-written from session titles), activity stats and chart
 * (from stats:get), time categories, and four AI-fluency skill cards.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElectronAPI, ReflectDigest } from "@/types/electron";

function api(): ElectronAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
}

interface Stats {
  sessions: number;
  peakHour: number | null;
  perDay: { date: string; count: number }[];
  perDayMinutes: { date: string; minutes: number }[];
}

const PALETTE = ["#a84b2a", "#c47a52", "#d9a380", "#ecc9ad", "#f4e2d0"];

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function mostActiveWeekday(perDay: { date: string; count: number }[]): string {
  const sums = new Array(7).fill(0) as number[];
  for (const d of perDay) {
    const day = new Date(d.date + "T12:00:00").getDay();
    sums[day] += d.count;
  }
  const max = Math.max(...sums);
  return max > 0 ? WEEKDAYS[sums.indexOf(max)] : "—";
}

function fmtHour(h: number | null): string {
  if (h == null) return "—";
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

/** Line chart with LABELLED dashed gridlines — every dash row says what value
 * it sits at (hours for time, messages for conversations). */
function ActivityChart({
  points,
  unit,
}: {
  points: { date: string; value: number }[];
  unit: "h" | "msgs";
}): JSX.Element {
  const W = 640;
  const H = 140;
  const PAD_L = 34;
  const max = Math.max(1, ...points.map((d) => d.value));
  const fmtVal = (v: number): string =>
    unit === "h" ? `${(v / 60).toFixed(v >= 60 ? 0 : 1)}h` : String(Math.round(v));
  const y = (v: number): number => H - 16 - (v / max) * (H - 40);
  const pts = points.map((d, i) => {
    const x =
      points.length > 1
        ? PAD_L + (i / (points.length - 1)) * (W - PAD_L - 6)
        : W / 2;
    return `${x.toFixed(1)},${y(d.value).toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line
            x1={PAD_L}
            x2={W - 4}
            y1={y(max * t)}
            y2={y(max * t)}
            className="stroke-border"
            strokeDasharray="2 4"
            strokeWidth={0.6}
          />
          <text
            x={PAD_L - 5}
            y={y(max * t) + 3}
            textAnchor="end"
            className="fill-muted-foreground"
            fontSize={9}
          >
            {fmtVal(max * t)}
          </text>
        </g>
      ))}
      {pts.length > 1 && (
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="#a84b2a"
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      )}
      <text x={PAD_L} y={H - 3} className="fill-muted-foreground" fontSize={9}>
        {points[0]?.date ?? ""}
      </text>
      <text
        x={W - 4}
        y={H - 3}
        textAnchor="end"
        className="fill-muted-foreground"
        fontSize={9}
      >
        {points[points.length - 1]?.date ?? ""}
      </text>
    </svg>
  );
}

const SKILL_ORDER = [
  ["delegation", "Delegation"],
  ["description", "Description"],
  ["discernment", "Discernment"],
  ["diligence", "Diligence"],
] as const;

export function ReflectSettings(): JSX.Element {
  const [days, setDays] = useState(30);
  const [chartMode, setChartMode] = useState<"time" | "msgs">("time");
  const [stats, setStats] = useState<Stats | null>(null);
  const [digest, setDigest] = useState<ReflectDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const [s, d] = await Promise.all([
          api()?.stats.get(days),
          api()?.reflect.digest(days, force),
        ]);
        if (s) setStats(s as Stats);
        if (d?.ok && d.digest) setDigest(d.digest);
        else if (d) setError(d.error ?? "Digest failed");
      } finally {
        setLoading(false);
      }
    },
    [days],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const label = (n: string): string => n.toUpperCase();

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Reflect</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Based on your conversations in this app.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none"
          >
            <option value={7}>Past week</option>
            <option value={30}>Past month</option>
            <option value={90}>Past 3 months</option>
          </select>
          <button
            type="button"
            title="Regenerate"
            onClick={() => void load(true)}
            className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading && !digest && (
        <p className="mt-4 text-sm text-muted-foreground">Reflecting…</p>
      )}

      {digest && (
        <>
          <h2 className="mt-6 font-serif text-2xl font-semibold leading-snug">
            {digest.headline}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {digest.narrative}
          </p>
        </>
      )}

      {stats && (
        <>
          <div className="mt-7 grid grid-cols-3 gap-4">
            {[
              [mostActiveWeekday(stats.perDay), "Most active day"],
              [fmtHour(stats.peakHour), "Peak hour"],
              [String(stats.sessions), "Total conversations"],
            ].map(([v, l]) => (
              <div key={l}>
                <div className="font-serif text-2xl">{v}</div>
                <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {l}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-7">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Your time with Claude
              </div>
              <div className="flex gap-0.5 rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.05]">
                {(["time", "msgs"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setChartMode(m)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                      chartMode === m
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m === "time" ? "Time spent" : "Messages"}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-border p-3">
              {chartMode === "time" ? (
                <ActivityChart
                  points={stats.perDayMinutes.map((d) => ({
                    date: d.date,
                    value: d.minutes,
                  }))}
                  unit="h"
                />
              ) : (
                <ActivityChart
                  points={stats.perDay.map((d) => ({
                    date: d.date,
                    value: d.count,
                  }))}
                  unit="msgs"
                />
              )}
            </div>
          </div>
        </>
      )}

      {digest && digest.categories.length > 0 && (
        <div className="mt-7">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            What you spent time on
          </div>
          <div className="mt-2 flex h-2.5 w-full gap-1 overflow-hidden rounded-full">
            {digest.categories.map((c, i) => (
              <div
                key={c.name}
                style={{
                  width: `${Math.max(2, c.pct)}%`,
                  background: PALETTE[i % PALETTE.length],
                }}
                className="rounded-sm"
                title={`${c.name}: ${c.pct}%`}
              />
            ))}
          </div>
          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {digest.categories.map((c, i) => (
              <div key={c.name} className="flex gap-2.5">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full"
                  style={{ background: PALETTE[i % PALETTE.length] }}
                />
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-serif text-sm font-semibold">
                      {c.name}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {c.pct}%
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {c.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {digest && (
        <div className="mb-4 mt-8">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Expanding your skills
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Your activity measured as AI fluency skills.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {SKILL_ORDER.map(([key, title]) => {
              const s = digest.skills[key];
              if (!s) return null;
              return (
                <div
                  key={key}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label(title)}
                  </div>
                  <div className="mt-1.5 font-serif text-sm font-semibold leading-snug">
                    {s.title}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {s.body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

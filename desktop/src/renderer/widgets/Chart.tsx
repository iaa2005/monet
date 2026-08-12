/**
 * A chart the model can draw by writing a fenced block.
 *
 * The model already has every way of GETTING data — RunPython with yfinance,
 * WebFetch, a shell command — and no way of SHOWING it except a table or a
 * PNG it had to render itself. A PNG costs a matplotlib round trip, comes out
 * at a fixed size, and cannot be hovered. This is the missing half: it has the
 * numbers, and this draws them.
 *
 * Hand-drawn SVG rather than a charting library. The whole widget is under
 * 300 lines and adds nothing to the bundle; recharts alone is ~500 KB, which
 * is a poor trade for four chart types. If the shapes ever outgrow this, that
 * is the moment to reach for a library — not before.
 */

import { useId, useMemo, useState } from "react";

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** A candle as it might arrive: the compact form, our form, or pandas'. */
type RawCandle =
  | number[]
  | Candle
  | { open?: number; high?: number; low?: number; close?: number };

export interface ChartSeries {
  name?: string;
  /** line/bar/area: one number per label. */
  data?: number[];
  /** candlestick: one OHLC row per label. */
  ohlc?: RawCandle[];
}

export interface ChartSpec {
  type?: "line" | "bar" | "area" | "candlestick";
  title?: string;
  subtitle?: string;
  labels?: string[];
  series?: ChartSeries[];
  /** One unnamed series, written at the top level. The first real chart a
   *  model drew came out this way — "give ohlc instead of data" read as
   *  replacing the series, not the field inside it — and it is the shorter,
   *  more obvious shape for a single line. Accepted. */
  data?: number[];
  ohlc?: RawCandle[];
  /** Shown under the title, e.g. "USD" or "%". */
  unit?: string;
  /** Force the y-axis to include zero. Bars do by default; lines do not. */
  zero?: boolean;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 46 };
const W = 720;
const H = 260;

/** Enough distinct hues for a legend anyone would read; beyond that a chart
 *  needs splitting, not more colours. */
const HUES = [212, 152, 28, 340, 268, 190];
const stroke = (i: number): string => `hsl(${HUES[i % HUES.length]} 72% 48%)`;
const fill = (i: number): string => `hsl(${HUES[i % HUES.length]} 72% 48% / 0.14)`;

/**
 * One candle, from whichever shape it arrived in.
 *
 * `[o, h, l, c]` is what a model reaches for after a pandas round trip, and
 * `{open, high, low, close}` is what yfinance itself names the columns. Both
 * are obvious readings of "give ohlc"; refusing either would mean a chart
 * that silently fell back to a code block for a payload that was not wrong,
 * only differently spelled.
 */
function toCandle(row: RawCandle): Candle | null {
  if (Array.isArray(row)) {
    const [o, h, l, c] = row;
    return [o, h, l, c].every((v) => typeof v === "number" && Number.isFinite(v))
      ? { o: o!, h: h!, l: l!, c: c! }
      : null;
  }
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const pick = (a: string, b: string): number | null => {
    const v = r[a] ?? r[b];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const o = pick("o", "open");
  const h = pick("h", "high");
  const l = pick("l", "low");
  const c = pick("c", "close");
  return o !== null && h !== null && l !== null && c !== null
    ? { o, h, l, c }
    : null;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max)
    return [min];
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step)
    out.push(Number(v.toFixed(10)));
  return out;
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

export function Chart({ spec }: { spec: ChartSpec }): JSX.Element {
  const clip = useId();
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    // A single series may be written at the top level; several must be in
    // `series`. Both reach the same shape here, so nothing below cares.
    const declared: ChartSeries[] =
      spec.series && spec.series.length > 0
        ? spec.series
        : spec.ohlc || spec.data
          ? [{ name: spec.title, data: spec.data, ohlc: spec.ohlc }]
          : [];
    const series = declared
      .map((s) => ({
        name: s.name,
        data: s.data,
        ohlc: s.ohlc?.map(toCandle).filter((c): c is Candle => c !== null),
      }))
      .filter((s) => (s.data?.length ?? 0) > 0 || (s.ohlc?.length ?? 0) > 0);
    const n = Math.max(
      0,
      ...series.map((s) => s.data?.length ?? s.ohlc?.length ?? 0),
    );
    const values: number[] = [];
    for (const s of series) {
      if (s.data) values.push(...s.data.filter(Number.isFinite));
      if (s.ohlc)
        for (const c of s.ohlc) values.push(c.h, c.l);
    }
    let min = values.length ? Math.min(...values) : 0;
    let max = values.length ? Math.max(...values) : 1;
    const bars = spec.type === "bar";
    if (spec.zero || bars) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (min === max) {
      min -= 1;
      max += 1;
    } else {
      // A candlestick chart hugging the top of its box reads as "at the high";
      // the padding is what makes the shape, not the edge, carry the meaning.
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }
    return { series, n, min, max };
  }, [spec]);

  const { series, n, min, max } = model;
  if (n === 0)
    return (
      <div className="my-3 rounded-xl border border-border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">
        This chart has no data.
      </div>
    );

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number): number =>
    n === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW;
  const y = (v: number): number =>
    PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  const labels = spec.labels ?? [];
  const ticks = niceTicks(min, max);
  const type = spec.type ?? "line";
  // Every nth label, so they never collide however many points there are.
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-border bg-card">
      {(spec.title || spec.subtitle) && (
        <figcaption className="border-b border-border/60 px-3 py-2">
          {spec.title && (
            <div className="text-sm font-medium text-foreground">
              {spec.title}
              {spec.unit && (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {spec.unit}
                </span>
              )}
            </div>
          )}
          {spec.subtitle && (
            <div className="text-[12px] text-muted-foreground">{spec.subtitle}</div>
          )}
        </figcaption>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[420px]"
          role="img"
          aria-label={spec.title ?? "chart"}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : "3 3"}
                opacity={t === 0 ? 0.9 : 0.5}
              />
              <text
                x={PAD.left - 6}
                y={y(t) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {fmt(t)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clip})`}>
            {series.map((s, si) => {
              if (type === "candlestick" && s.ohlc) {
                const bw = Math.max(1.5, Math.min(12, (plotW / n) * 0.6));
                return (
                  <g key={si}>
                    {s.ohlc.map((c, i) => {
                      const up = c.c >= c.o;
                      const col = up ? "hsl(152 62% 40%)" : "hsl(0 68% 52%)";
                      const top = y(Math.max(c.o, c.c));
                      const bot = y(Math.min(c.o, c.c));
                      return (
                        <g key={i}>
                          <line
                            x1={x(i)}
                            x2={x(i)}
                            y1={y(c.h)}
                            y2={y(c.l)}
                            stroke={col}
                            strokeWidth={1}
                          />
                          <rect
                            x={x(i) - bw / 2}
                            y={top}
                            width={bw}
                            height={Math.max(1, bot - top)}
                            fill={col}
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              }
              const data = s.data ?? [];
              if (type === "bar") {
                const bw = Math.max(1, Math.min(28, (plotW / n) * 0.7));
                return (
                  <g key={si}>
                    {data.map((v, i) => (
                      <rect
                        key={i}
                        x={x(i) - bw / 2}
                        y={Math.min(y(v), y(0))}
                        width={bw}
                        height={Math.max(1, Math.abs(y(v) - y(0)))}
                        fill={stroke(si)}
                        opacity={0.85}
                      />
                    ))}
                  </g>
                );
              }
              const d = data
                .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`)
                .join(" ");
              return (
                <g key={si}>
                  {type === "area" && (
                    <path
                      d={`${d} L${x(data.length - 1)},${y(min)} L${x(0)},${y(min)} Z`}
                      fill={fill(si)}
                    />
                  )}
                  <path d={d} fill="none" stroke={stroke(si)} strokeWidth={1.75} />
                </g>
              );
            })}
          </g>

          {labels.map((l, i) =>
            i % labelEvery === 0 ? (
              <text
                key={i}
                x={x(i)}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {l}
              </text>
            ) : null,
          )}

          {/* One hit strip per point: hovering a 1px line is not a thing
              anyone can do. */}
          {Array.from({ length: n }, (_, i) => (
            <rect
              key={i}
              x={x(i) - plotW / n / 2}
              y={PAD.top}
              width={plotW / n}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              className="stroke-foreground"
              strokeWidth={1}
              opacity={0.35}
            />
          )}
        </svg>
      </div>

      {(series.length > 1 || hover !== null) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-3 py-1.5 text-[11px]">
          {hover !== null && labels[hover] && (
            <span className="font-medium text-foreground">{labels[hover]}</span>
          )}
          {series.map((s, si) => {
            const c = s.ohlc?.[hover ?? -1];
            const v = s.data?.[hover ?? -1];
            return (
              <span key={si} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 rounded-sm"
                  style={{ background: stroke(si) }}
                />
                <span className="text-muted-foreground">{s.name ?? `series ${si + 1}`}</span>
                {c && (
                  <span className="font-mono text-foreground">
                    O {fmt(c.o)} H {fmt(c.h)} L {fmt(c.l)} C {fmt(c.c)}
                  </span>
                )}
                {v !== undefined && Number.isFinite(v) && (
                  <span className="font-mono text-foreground">{fmt(v)}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </figure>
  );
}

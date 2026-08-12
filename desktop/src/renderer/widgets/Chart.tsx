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

import { useId, useMemo, useRef, useState } from "react";

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
  /** The long name beside the ticker — "Tesla, Inc." next to TSLA. A symbol
   *  is an abbreviation, and the chart should not make anyone expand it. */
  name?: string;
  /** Shown under the title, e.g. "USD" or "%". */
  unit?: string;
  /** Optional, one per label. Shown in the readout beside the OHLC row —
   *  volume is half of what anyone reads a price chart for. */
  volume?: number[];
  /** Force the y-axis to include zero. Bars do by default; lines do not. */
  zero?: boolean;
  /** A file in this chat's sandbox holding the rows, so the model does not
   *  retype hundreds of numbers it already computed. See ChartFromFile. */
  src?: string;
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

/**
 * The axis form of a label.
 *
 * Full ISO stamps do not fit: "2026-07-13 09:30" is ~95px at 10px, the slots
 * are ~90px, and eight of them ran into each other. The year is the same for
 * every label on a one-month chart, so it carries nothing and goes; the rest
 * reads the way a price chart is scanned — 07/13, 07/13 09:30.
 */
function axisLabel(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s);
  if (!m) return s;
  return m[4] ? `${m[2]}/${m[3]} ${m[4]}` : `${m[2]}/${m[3]}`;
}

/** A chip's width from its text — a fixed one truncated "2026-07-27 10:30"
 *  to "26-07-27 10", which reads as a different date. */
const chipWidth = (text: string): number => text.length * 5.7 + 12;

/** Axis and readout prices keep their cents. fmt() rounds anything over 100 to
 *  a whole number, which on a $300 stock hides the entire day's move. */
function price(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return fmt(n);
  return n.toFixed(2);
}

/**
 * Roughly how many horizontal gridlines to aim for.
 *
 * Four left a $300 stock with lines a hundred dollars apart, so reading a
 * candle's level off the axis meant estimating a third of the gap. Seven puts
 * them close enough to read against, which is the only thing a gridline is
 * for.
 */
const Y_TICKS = 7;

function niceTicks(min: number, max: number, count = Y_TICKS): number[] {
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
  const svgRef = useRef<SVGSVGElement>(null);
  /**
   * The cursor is two independent things, which is how a trading chart works:
   * the vertical arm SNAPS to the nearest candle, because a price belongs to a
   * bar; the horizontal arm follows the pointer FREELY, because the question it
   * answers is "what price is the level I am pointing at" — a support line, a
   * previous high — and that is rarely a close.
   *
   * Snapping both was the first version, and it could only ever tell you what
   * the readout already said.
   */
  const [cursor, setCursor] = useState<{ i: number; price: number } | null>(null);
  const hover = cursor?.i ?? null;

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
  // Spacing from the WIDTH of the compacted labels, not a fixed count: an
  // hourly chart's "07/13 09:30" needs twice the room a daily "07/13" does,
  // and eight of the long form ran into each other.
  const axisLabels = labels.map(axisLabel);
  const widest = Math.max(1, ...axisLabels.map((l) => l.length)) * 5.7 + 14;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / widest))));

  // The readout follows the cursor, and falls back to the last point when the
  // cursor is away — so a candlestick chart says what it closed at without
  // anyone having to hover for it.
  const at = hover ?? n - 1;
  const candles = series.find((s) => s.ohlc?.length)?.ohlc;
  const candle = candles?.[at];
  const prevClose = candles?.[at - 1]?.c;
  const change =
    candle && prevClose !== undefined ? candle.c - prevClose : undefined;
  const up = (change ?? 0) >= 0;

  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-border bg-card">
      {(spec.title || spec.subtitle || candle) && (
        <figcaption className="border-b border-border/60 px-3 py-2">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {spec.title && (
                  <span className="text-sm font-medium text-foreground">
                    {spec.title}
                  </span>
                )}
                {spec.name && (
                  <span className="text-[13px] text-foreground/80">
                    {spec.name}
                  </span>
                )}
                {spec.unit && (
                  <span className="text-[12px] text-muted-foreground">
                    {spec.unit}
                  </span>
                )}
                {labels[at] && (
                  <span className="text-[12px] text-muted-foreground">
                    {labels[at]}
                  </span>
                )}
              </div>
              {candle && (
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span
                    className="text-xl font-semibold tabular-nums"
                    style={{ color: up ? "hsl(152 62% 40%)" : "hsl(0 68% 52%)" }}
                  >
                    {price(candle.c)}
                  </span>
                  {change !== undefined && (
                    <span
                      className="text-[13px] tabular-nums"
                      style={{ color: up ? "hsl(152 62% 40%)" : "hsl(0 68% 52%)" }}
                    >
                      {up ? "+" : ""}
                      {price(change)}({up ? "+" : ""}
                      {((change / (prevClose || 1)) * 100).toFixed(2)}%)
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Labels over values, right-aligned — the shape a quote board has
                had for forty years, and the reason the eye finds Close without
                reading the word. */}
            {candle && (
              <div className="flex shrink-0 gap-4 text-right">
                {(
                  [
                    ["Open", price(candle.o)],
                    ["Close", price(candle.c)],
                    ["High", price(candle.h)],
                    ["Low", price(candle.l)],
                    ...(spec.volume?.[at] !== undefined
                      ? ([["Volume", fmt(spec.volume[at]!)]] as [string, string][])
                      : []),
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[11px] text-muted-foreground">{k}</div>
                    <div className="text-[13px] tabular-nums text-foreground">
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {spec.subtitle && (
            <div className="mt-1 text-[12px] text-muted-foreground">
              {spec.subtitle}
            </div>
          )}
        </figcaption>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[420px]"
          role="img"
          aria-label={spec.title ?? "chart"}
          ref={svgRef}
          onMouseLeave={() => setCursor(null)}
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

          {axisLabels.map((l, i) =>
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

          {/* One surface over the whole plot rather than a strip per point:
              the y position has to be read too, and a strip only knows its
              own column. */}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={(e) => {
              const box = svgRef.current?.getBoundingClientRect();
              if (!box) return;
              // Client pixels to viewBox units — the svg is width:100%, so the
              // two only agree by accident.
              const px = ((e.clientX - box.left) / box.width) * W;
              const py = ((e.clientY - box.top) / box.height) * H;
              const i =
                n === 1
                  ? 0
                  : Math.round(((px - PAD.left) / plotW) * (n - 1));
              setCursor({
                i: Math.min(n - 1, Math.max(0, i)),
                price: min + ((PAD.top + plotH - py) / plotH) * (max - min),
              });
            }}
          />
          {/* A crosshair, not just a rule: the horizontal arm and its axis
              chip answer "what price is that" without counting gridlines,
              which is the whole reason to hover a price chart at all. */}
          {hover !== null &&
            (() => {
              // The pointer's own price, not the candle's close — that is
              // the whole point of a free horizontal arm.
              const v = cursor?.price;
              const yv = typeof v === "number" ? y(v) : null;
              const label = labels[hover];
              // Clamped so a chip at either end stays inside the plot.
              const half = label ? chipWidth(label) / 2 : 0;
              const cx = Math.min(
                Math.max(x(hover), PAD.left + half),
                W - PAD.right - half,
              );
              return (
                <g pointerEvents="none">
                  <line
                    x1={x(hover)}
                    x2={x(hover)}
                    y1={PAD.top}
                    y2={PAD.top + plotH}
                    className="stroke-foreground"
                    strokeWidth={1}
                    opacity={0.35}
                    strokeDasharray="4 3"
                  />
                  {yv !== null && (
                    <>
                      <line
                        x1={PAD.left}
                        x2={W - PAD.right}
                        y1={yv}
                        y2={yv}
                        className="stroke-foreground"
                        strokeWidth={1}
                        opacity={0.35}
                        strokeDasharray="4 3"
                      />
                      <rect
                        x={2}
                        y={yv - 8}
                        width={PAD.left - 6}
                        height={16}
                        rx={3}
                        className="fill-foreground"
                      />
                      <text
                        x={PAD.left - 8}
                        y={yv + 3.5}
                        textAnchor="end"
                        className="fill-background"
                        style={{ fontSize: 10 }}
                      >
                        {price(v as number)}
                      </text>
                    </>
                  )}
                  {label && (
                    <>
                      <rect
                        x={cx - chipWidth(label) / 2}
                        y={H - 17}
                        width={chipWidth(label)}
                        height={15}
                        rx={3}
                        className="fill-foreground"
                      />
                      <text
                        x={cx}
                        y={H - 6}
                        textAnchor="middle"
                        className="fill-background"
                        style={{ fontSize: 9.5 }}
                      >
                        {label}
                      </text>
                    </>
                  )}
                </g>
              );
            })()}
        </svg>
      </div>

      {/* Candlesticks say everything in the header now, so a second readout
          below would just repeat it. Lines still need a legend — a colour
          without a name is a colour. */}
      {!candle && (series.length > 1 || hover !== null) && (
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

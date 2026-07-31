/**
 * Reading the colour codes a command line writes.
 *
 * Vite, npm, cargo, jest — everything a tool runs paints its output, and the
 * paint is escape sequences interleaved with the text. Printed literally they
 * are worse than noise: `[32m[1mVITE[22m v8.2.0[39m` hides the version
 * behind punctuation, and in Vite's case an escape sits INSIDE the port number,
 * so the one fact you wanted is unreadable.
 *
 * Two failure modes to avoid, and they pull in opposite directions. Dropping
 * everything that starts with an escape loses the colour that made the output
 * legible in the first place. Rendering only SGR and leaving the rest as text
 * puts cursor-movement codes on screen, which is the same garbage in a smaller
 * quantity.
 *
 * Dependency-free and pure: this is a parser for a format we do not control.
 */

export interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

/**
 * The 16 base colours.
 *
 * Not the xterm palette: that one is tuned for a black terminal, and its blue
 * (#0000ee) is unreadable on this app's dark background and barely better on
 * its light one. These are the same hues at a lightness that works on both.
 */
const BASE = [
  "#5b6270", // black → a grey you can actually see
  "#e5484d",
  "#30a46c",
  "#d4a72c",
  "#3b82f6",
  "#a855f7",
  "#0ea5e9",
  "#9ca3af",
];
const BRIGHT = [
  "#8b929e",
  "#ff6369",
  "#4cc38a",
  "#f5d90a",
  "#60a5fa",
  "#c084fc",
  "#38bdf8",
  "#e5e7eb",
];

/** xterm-256: 16 base, a 6×6×6 cube, then 24 greys. */
function color256(n: number): string {
  if (n < 8) return BASE[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const i = n - 16;
    const step = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    const r = step(Math.floor(i / 36));
    const g = step(Math.floor((i % 36) / 6));
    const b = step(i % 6);
    return `rgb(${r} ${g} ${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v} ${v} ${v})`;
}

/** Any escape sequence: SGR is handled, the rest is removed. */
const ESCAPE = /(?:\[[0-9;?]*([A-Za-z])|\][^]*(?:|\\)|[()][0-9A-Za-z]|[=>NOM78])/g;

export function hasAnsi(text: string): boolean {
  ESCAPE.lastIndex = 0;
  return ESCAPE.test(text);
}

/** Apply one SGR parameter list to a style, returning the new style. */
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      for (const k of Object.keys(next)) delete (next as Record<string, unknown>)[k];
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p >= 30 && p <= 37) next.color = BASE[p - 30];
    else if (p === 39) delete next.color;
    else if (p >= 40 && p <= 47) next.background = BASE[p - 40];
    else if (p === 49) delete next.background;
    else if (p >= 90 && p <= 97) next.color = BRIGHT[p - 90];
    else if (p >= 100 && p <= 107) next.background = BRIGHT[p - 100];
    else if (p === 38 || p === 48) {
      // 38;5;N (256) or 38;2;R;G;B (truecolor) — the parameters that follow
      // belong to this one, so the loop has to skip them.
      const key = p === 38 ? "color" : "background";
      if (params[i + 1] === 5) {
        next[key] = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        next[key] = `rgb(${params[i + 2] ?? 0} ${params[i + 3] ?? 0} ${params[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  return next;
}

/**
 * Split text into styled spans.
 *
 * Adjacent runs under one style are merged, because a coloured word in real
 * output is wrapped in its own escapes and would otherwise become three spans
 * with identical styling.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let last = 0;

  const push = (text: string): void => {
    if (!text) return;
    const prev = spans[spans.length - 1];
    if (prev && sameStyle(prev.style, style)) prev.text += text;
    else spans.push({ text, style: { ...style } });
  };

  ESCAPE.lastIndex = 0;
  for (const m of input.matchAll(ESCAPE)) {
    const at = m.index ?? 0;
    push(input.slice(last, at));
    last = at + m[0].length;
    // Only SGR ("m") changes how text looks. Cursor moves, screen clears and
    // OSC titles are dropped: they mean nothing in a transcript, and showing
    // them is the garbage this exists to remove.
    if (m[1] !== "m") continue;
    const body = m[0].slice(2, -1);
    const params = body
      .split(";")
      .map((s) => (s === "" ? 0 : Number(s)))
      .filter((n) => Number.isFinite(n));
    style = applySgr(style, params.length ? params : [0]);
  }
  push(input.slice(last));
  return spans;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline
  );
}

/** The text with every escape removed — for anything that cannot show colour. */
export function stripAnsi(input: string): string {
  return input.replace(ESCAPE, "");
}

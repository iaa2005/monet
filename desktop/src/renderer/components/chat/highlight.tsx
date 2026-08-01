/**
 * Per-line syntax highlighting for diff rows. react-syntax-highlighter renders
 * a whole block at once, which can't be interleaved with per-row diff chrome —
 * so we tokenize with refractor (the same engine it uses under the hood) and
 * split the token tree into one ReactNode per source line. Token colours come
 * from the `.diff-hl .token.*` rules in globals.css (tuned to match the
 * oneDark / oneLight themes the plain CodeBlock uses).
 *
 * Also exports `HighlightedCode` — a drop-in replacement for
 * react-syntax-highlighter's `<SyntaxHighlighter>` that uses refractor
 * directly (no extra library overhead, no `wrapLongLines` perf hit).
 */

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import refractor from "refractor";
import { cn } from "@/lib/utils";
import { fixLatexEscapedDollar } from "./latex-dollar";

// Applied once, at import, so every code block gets the corrected grammar.
fixLatexEscapedDollar(refractor);

/** Reactively tracks the `dark` class on <html> so highlighting follows theme. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() =>
      setDark(el.classList.contains("dark")),
    );
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
}
type HastNode = HastText | HastElement;

/** refractor@3 returns a node array here; older/newer shapes wrap in a root. */
function tokenize(code: string, lang: string): HastNode[] {
  const out = refractor.highlight(code, lang);
  if (Array.isArray(out)) return out as HastNode[];
  return ((out as { children?: HastNode[] } | null)?.children ?? []) as HastNode[];
}

function isLanguageKnown(lang: string): boolean {
  try {
    return lang !== "" && lang !== "text" && refractor.registered(lang);
  } catch {
    return false;
  }
}

/**
 * Walk the token tree into FLAT tokens per line: one span each, with the
 * ancestor classes merged into a single string.
 *
 * The nested shape Prism produces (a tag inside a tag inside a tag) was
 * rebuilt per leaf and rendered as nested spans, which put thousands of
 * small styled elements in the DOM for one screen of HTML. Tokenizing the
 * whole file takes 7ms; it was the elements that cost hundreds of
 * milliseconds — the same file with highlighting off rendered instantly.
 * Merging the classes keeps every CSS rule matching (they are all
 * `.token.<kind>`) while collapsing the depth to one.
 */
interface FlatToken {
  cls: string;
  text: string;
}

function splitIntoLines(nodes: HastNode[]): FlatToken[][] {
  const lines: FlatToken[][] = [[]];
  const walk = (node: HastNode, cls: string): void => {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i]) lines[lines.length - 1].push({ cls, text: parts[i] });
      }
      return;
    }
    const own = node.properties?.className;
    const ownStr = own ? (Array.isArray(own) ? own.join(" ") : own) : "";
    const merged = ownStr ? (cls ? cls + " " + ownStr : ownStr) : cls;
    for (const child of node.children ?? []) walk(child, merged);
  };
  for (const node of nodes) walk(node, "");
  return lines;
}

/**
 * Highlight `code`, returning one ReactNode per source line (indexable by
 * 0-based line number). Unknown languages / failures fall back to raw text per
 * line, so a diff never fails to render.
 */
export function highlightLines(code: string, language: string): ReactNode[] {
  const plain = (): ReactNode[] => code.split("\n");
  if (!isLanguageKnown(language)) return plain();
  try {
    return splitIntoLines(tokenize(code, language)).map((line) => {
      // A line of one unclassified token is just text: no element at all.
      if (line.length === 0) return "";
      if (line.length === 1 && !line[0].cls) return line[0].text;
      return (
        <>
          {line.map((t, i) =>
            t.cls ? (
              <span key={i} className={t.cls}>
                {t.text}
              </span>
            ) : (
              t.text
            ),
          )}
        </>
      );
    });
  } catch {
    return plain();
  }
}

/** Highlight a single line of code. */
export function highlightOne(text: string, language: string): ReactNode {
  return highlightLines(text, language)[0] ?? text;
}

/**
 * Full-block syntax highlighting via refractor — replaces react-syntax-highlighter.
 * Avoids the `wrapLongLines` performance hit (uses CSS `white-space: pre-wrap`
 * instead of JS-based character measurement).
 *
 * Two costs are bounded here. TOKENIZING: past the threshold the text renders
 * plain — never truncated (an earlier version cut the content itself off,
 * which silently amputated any file over 30 KB in the viewer). RENDERING:
 * results are cached across mounts keyed by content, so re-parenting a dock
 * panel or reopening a file does not re-tokenize; the per-line
 * content-visibility rules in globals.css keep offscreen lines out of layout
 * and paint entirely, which is what lets a 10k-line file scroll flat.
 */
const MAX_HIGHLIGHT_CHARS = 120_000;

/** Tokenized lines by content — survives unmounts (dock drags, tab flips).
 * ReactNodes are immutable, so sharing them between mounts is safe. */
const HL_CACHE = new Map<string, ReactNode[]>();
const HL_CACHE_MAX = 40;

/**
 * Tokenizing is done in BLOCKS, not whole files.
 *
 * Virtualization bounded the DOM but not the work: opening a 1200-line HTML
 * file tokenized all of it inside the render and blocked the main thread for
 * 628ms, measured — the app visibly stopped responding, which is exactly what
 * was reported. Markup is the worst case (~7x TypeScript per character, its
 * grammar nests CSS and JS), so the file that freezes is not even a big one.
 *
 * A block is tokenized when it first comes into view and cached after that.
 * The cost per block is a few milliseconds, and a construct that spans more
 * than a block loses its context — bounded, and invisible next to a UI that
 * stops answering.
 */
// 150 lines, measured on the worst grammar (markup): 33ms per block, under
// the 50ms a dropped frame costs. 400 was 95ms — smooth enough to scroll, but
// still a visible hitch when a file opens.
const BLOCK_LINES = 150;
const BLOCK_CACHE = new Map<string, ReactNode[]>();
const BLOCK_CACHE_MAX = 120;

/** Blocks already queued, and languages that proved too costly to colour. */
const BLOCK_PENDING = new Set<string>();
const TOO_EXPENSIVE = new Set<string>();
/** A block slower than this is not worth a frame. Measured: 150 lines of CSS
 * nested inside markup cost ~500ms, and three in a row is the second a user
 * spends watching nothing happen. */
const BLOCK_BUDGET_MS = 60;
/** Lines tokenized to estimate what the whole block would cost. */
const SAMPLE_LINES = 20;

function blockKey(text: string, language: string): string {
  return language + "\u0000" + text;
}

/** Tokens for a block, or null when it has not been tokenized yet. */
function cachedBlock(text: string, language: string): ReactNode[] | null {
  const key = blockKey(text, language);
  const hit = BLOCK_CACHE.get(key);
  if (!hit) return null;
  BLOCK_CACHE.delete(key);
  BLOCK_CACHE.set(key, hit);
  return hit;
}

/**
 * Tokenize a block WITHOUT blocking the render - in idle time, telling the
 * caller when the colours are ready.
 *
 * Tokenizing used to happen inside the render, so scrolling into a fresh part
 * of a file blocked for over a second at a time (measured on a 324-line HTML
 * file: 1151ms, then 609ms). Now the text appears immediately, plain, and the
 * colours arrive a beat later. A block that blows the budget stops the
 * colouring for that language: a plain file that scrolls beats a coloured one
 * that does not.
 */
function scheduleBlock(text: string, language: string, onReady: () => void): void {
  const key = blockKey(text, language);
  if (BLOCK_PENDING.has(key) || TOO_EXPENSIVE.has(key)) return;
  BLOCK_PENDING.add(key);
  const run = (): void => {
    BLOCK_PENDING.delete(key);
    // Cost is ESTIMATED before it is paid. An idle callback does not get
    // interrupted: a 600ms tokenization in idle time blocks the next frame
    // exactly as it would in the render, which is why moving it here was not
    // enough on its own. So a small sample is measured first, and a block
    // whose projection blows the budget simply stays plain — the file scrolls,
    // it just is not coloured. That is the trade the user asked for: "невозможно
    // листать" is worse than grey text.
    const sample = text
      .split("\n")
      .slice(0, SAMPLE_LINES)
      .join("\n");
    const t0 = performance.now();
    highlightLines(sample, language);
    const sampleMs = performance.now() - t0;
    const lineCount = Math.max(1, text.split("\n").length);
    const projected = (sampleMs * lineCount) / Math.min(SAMPLE_LINES, lineCount);
    if (projected > BLOCK_BUDGET_MS) {
      TOO_EXPENSIVE.add(key);
      return;
    }
    const lines = highlightLines(text, language);
    BLOCK_CACHE.set(key, lines);
    if (BLOCK_CACHE.size > BLOCK_CACHE_MAX)
      BLOCK_CACHE.delete(BLOCK_CACHE.keys().next().value as string);
    onReady();
  };
  // `typeof window` because this module is also imported by probes running
  // under plain Node — a renderer file that assumes a DOM cannot be tested
  // without one.
  const w =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as {
          requestIdleCallback?: (
            cb: () => void,
            o?: { timeout: number },
          ) => number;
        });
  if (w?.requestIdleCallback) w.requestIdleCallback(run, { timeout: 500 });
  else setTimeout(run, 0);
}

/**
 * The tokenized lines for [start, end) — only the blocks that range touches.
 * Exported for the probe: this is the function whose cost used to be the
 * whole file.
 */
export function windowedLines(
  plain: string[],
  language: string,
  rawStart: number,
  rawEnd: number,
  /** Called when a block finishes colouring in the background. */
  onReady?: () => void,
): ReactNode[] {
  // Clamped here, not just at the call site: an end past the last line used
  // to emit one empty row per missing line (asked for [6, 99) of an 8-line
  // file, got 93 rows). The window hook clamps too, so this never bit — but
  // a helper that trusts its caller is a bug waiting for a second caller.
  const start = Math.max(0, Math.min(rawStart, plain.length));
  const end = Math.max(start, Math.min(rawEnd, plain.length));
  const out: ReactNode[] = [];
  const firstBlock = Math.floor(start / BLOCK_LINES);
  const lastBlock = Math.floor(Math.max(start, end - 1) / BLOCK_LINES);
  for (let b = firstBlock; b <= lastBlock; b++) {
    const from = b * BLOCK_LINES;
    const text = plain.slice(from, from + BLOCK_LINES).join("\n");
    const tokenized = cachedBlock(text, language);
    if (!tokenized && onReady) scheduleBlock(text, language, onReady);
    const lo = Math.max(start, from);
    const hi = Math.min(end, from + BLOCK_LINES);
    for (let i = lo; i < hi; i++)
      out.push(tokenized ? (tokenized[i - from] ?? plain[i]) : plain[i]);
  }
  return out;
}

function linesFor(code: string, language: string): ReactNode[] {
  // Small blocks tokenize in microseconds, and a streaming block re-arrives
  // grown on every flush — caching those would only churn the LRU out of the
  // big entries it exists for.
  if (code.length < 2_000) return highlightLines(code, language);
  const key = `${language}\u0000${code}`;
  const hit = HL_CACHE.get(key);
  if (hit) {
    // Keep hot entries alive: Map iterates in insertion order, so re-insert.
    HL_CACHE.delete(key);
    HL_CACHE.set(key, hit);
    return hit;
  }
  const lines =
    code.length > MAX_HIGHLIGHT_CHARS
      ? code.split("\n")
      : highlightLines(code, language);
  HL_CACHE.set(key, lines);
  if (HL_CACHE.size > HL_CACHE_MAX)
    HL_CACHE.delete(HL_CACHE.keys().next().value as string);
  return lines;
}

// ── Virtualization (the VS Code approach) ─────────────────────────────
//
// Past the threshold, lines stop wrapping (white-space: pre, horizontal
// scroll — exactly what editors do) so every row is EXACTLY one line-height
// tall, and only the rows in view (plus overscan) are mounted; two padding
// spacers keep the scrollbar honest. Fixed heights are the whole trick: no
// estimates, so no measure→shift→re-measure feedback with the scroller.
// (A previous attempt used CSS content-visibility on wrapped lines — wrong
// estimated heights sent Chromium into exactly that relayout loop, freezing
// the app on multi-thousand-line files.)
// 200 lines. The file that froze the app in the field was 324 lines of HTML
// — under the old 500 threshold, so it rendered whole: 168ms to tokenize and
// every row in the DOM, twice (mount, then a re-render). Markup is expensive
// enough that "not a big file" is not a defence.
const VIRTUAL_THRESHOLD = 200;
const LINE_H = 20; // 12.5px × 1.6 line-height
const PRE_PAD = 12; // 0.75rem pre padding
const OVERSCAN = 8;
// The window snaps to a multiple of this. Bigger = fewer re-renders while
// scrolling, more rows mounted; 50 rows is ~1000px of travel between them.
const STEP = 25;

/**
 * Which lines to mount, and where the rows layer sits.
 *
 * Two jobs, deliberately split by cost:
 *
 *   - the WINDOW (which lines exist in the DOM) changes rarely - snapped to
 *     STEP rows, so scrolling a screen costs one React render, not sixty;
 *   - the OFFSET (where those rows are drawn) changes every frame, and is
 *     applied straight to the DOM as a transform. React never sees it.
 *
 * The rows layer is sticky at the top of the scroller, so what gets painted
 * is only ever a viewport's worth. The tall part of the document is an empty
 * sizer: it gives the scrollbar its range and costs nothing to draw. A tall
 * PAINTED box is what cost 780ms per commit - 3400x6500 pixels of canvas for
 * a 324-line file, while the same panel with a 10-line file cost nothing.
 */
function useLineWindow(
  preRef: RefObject<HTMLPreElement | null>,
  rowsRef: RefObject<HTMLDivElement | null>,
  total: number,
  enabled: boolean,
): { start: number; end: number } {
  const [win, setWin] = useState(() =>
    enabled ? { start: 0, end: 0 } : { start: 0, end: total },
  );
  useEffect(() => {
    if (!enabled) {
      setWin({ start: 0, end: total });
      return;
    }
    const pre = preRef.current;
    if (!pre) return;
    let scroller: HTMLElement | null = pre.parentElement;
    while (scroller) {
      const st = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(st.overflowY)) break;
      scroller = scroller.parentElement;
    }
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const viewH = scroller ? scroller.clientHeight : window.innerHeight;
      const scrollTop = scroller ? scroller.scrollTop : window.scrollY;
      const preTop = scroller
        ? pre.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : pre.getBoundingClientRect().top + window.scrollY;
      const within = scrollTop - preTop;
      // The rows layer is pinned to the viewport; this puts its children back
      // where the document says they are. Straight to the DOM, no re-render.
      const rows = rowsRef.current;
      if (rows) rows.style.transform = `translateY(${-Math.max(0, within)}px)`;

      const first = Math.floor((within - PRE_PAD) / LINE_H);
      const visible = Math.ceil(viewH / LINE_H);
      const start = Math.max(0, Math.floor((first - OVERSCAN) / STEP) * STEP);
      const end = Math.min(
        total,
        Math.ceil((Math.max(first, 0) + visible + OVERSCAN) / STEP) * STEP,
      );
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
    };
    update();
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const target: EventTarget = scroller ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    const ro = scroller ? new ResizeObserver(onScroll) : null;
    if (scroller) ro?.observe(scroller);
    return () => {
      target.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, total, preRef, rowsRef]);
  return win;
}

/**
 * Rows placed by coordinate - one absolute box each, at the position the
 * document says. Nothing reflows when the window moves: rows are added and
 * removed, never pushed.
 */
const CodeRowsAbsolute = memo(function CodeRowsAbsolute({
  lines,
  first,
  showLineNumbers,
}: {
  lines: ReactNode[];
  first: number;
  showLineNumbers: boolean;
}): JSX.Element {
  return (
    <>
      {lines.map((node, idx) => {
        const i = first + idx;
        return (
          <span
            key={i}
            className="line"
            data-ln={i + 1}
            style={{ top: i * LINE_H + PRE_PAD }}
          >
            {showLineNumbers ? <span className="ln">{i + 1}</span> : null}
            <span className="cl">{node}</span>
          </span>
        );
      })}
    </>
  );
});

export function HighlightedCode({
  code,
  language = "text",
  showLineNumbers = false,
  className,
}: {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  className?: string;
}): JSX.Element {
  // Splitting into lines is cheap (a couple of ms for a 100 KB file) and it
  // is all that is needed to know how tall the document is. TOKENIZING is the
  // expensive half, and past the threshold it happens per visible block, in
  // idle time.
  const plain = useMemo(() => code.split("\n"), [code]);
  const preRef = useRef<HTMLPreElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const virtual = plain.length >= VIRTUAL_THRESHOLD;
  const { start, end } = useLineWindow(preRef, rowsRef, plain.length, virtual);
  const small = useMemo(
    () => (virtual ? null : linesFor(code, language)),
    [virtual, code, language],
  );
  // A block finishing in the background bumps this, and only then are the
  // colours picked up - the render itself never waits for them.
  const [coloured, setColoured] = useState(0);
  const onColoured = useMemo(() => () => setColoured((n) => n + 1), []);
  const slice = useMemo(
    () =>
      virtual
        ? windowedLines(plain, language, start, end, onColoured)
        : (small ?? plain),
    // `coloured` is a dependency on purpose: it is the signal that the cache
    // now holds something this window wants.
    [virtual, plain, language, start, end, small, onColoured, coloured],
  );
  // Numbers are rendered as text, not CSS counters: rows outside the window
  // do not exist, so a counter would restart at the window's edge.
  const digits = String(plain.length).length;
  // The widest line, in characters - computed once per file, never measured
  // per row. It gives the scroller a stable width without asking the browser
  // to lay out every line to find one (which is what max-content did).
  const widestCh = useMemo(() => {
    let w = 0;
    for (const l of plain) if (l.length > w) w = l.length;
    return Math.min(w, 2000) + digits + 4;
  }, [plain, digits]);

  const fontStyle = {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.6",
    background: "transparent",
    ["--ln-digits" as string]: digits,
  } as const;

  if (virtual)
    return (
      <pre
        ref={preRef}
        className={cn("diff-hl virt m-0", showLineNumbers && "show-ln", className)}
        style={{ ...fontStyle, width: `${widestCh}ch`, minWidth: "100%" }}
      >
        {/* Empty, and as tall as the document: the scrollbar's range. */}
        <div style={{ height: plain.length * LINE_H + PRE_PAD * 2 }} />
        <div className="virt-rows" ref={rowsRef}>
          <CodeRowsAbsolute
            lines={slice}
            first={start}
            showLineNumbers={showLineNumbers}
          />
        </div>
      </pre>
    );

  return (
    <pre
      ref={preRef}
      className={cn(
        "diff-hl m-0 whitespace-pre-wrap break-words",
        showLineNumbers && "show-ln",
        className,
      )}
      style={{ ...fontStyle, padding: "0.75rem" }}
    >
      <code>
        {slice.map((node, i) => (
          <span key={i} className="line" data-ln={i + 1}>
            {showLineNumbers ? <span className="ln">{i + 1}</span> : null}
            <span className="cl">{node}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

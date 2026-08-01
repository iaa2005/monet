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

/** Clone an element node without its children (used as a wrapper frame). */
function frame(node: HastElement): HastElement {
  return { type: "element", tagName: node.tagName, properties: node.properties };
}

/**
 * Walk the token tree, splitting on newlines inside text nodes. Every leaf is
 * re-wrapped in its ancestor element stack so a line can be rendered in
 * isolation while keeping its token classes.
 */
function splitIntoLines(nodes: HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]];
  const walk = (node: HastNode, stack: HastElement[]): void => {
    if (node.type === "text") {
      const parts = node.value.split("\n");
      parts.forEach((part, idx) => {
        if (idx > 0) lines.push([]);
        if (!part) return;
        let leaf: HastNode = { type: "text", value: part };
        for (let s = stack.length - 1; s >= 0; s--)
          leaf = { ...frame(stack[s]), children: [leaf] };
        lines[lines.length - 1].push(leaf);
      });
      return;
    }
    for (const child of node.children ?? []) walk(child, [...stack, frame(node)]);
  };
  for (const node of nodes) walk(node, []);
  return lines;
}

function toReact(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  const cls = node.properties?.className;
  return (
    <span key={key} className={Array.isArray(cls) ? cls.join(" ") : cls}>
      {node.children?.map((c, i) => toReact(c, i))}
    </span>
  );
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
    return splitIntoLines(tokenize(code, language)).map((line) => (
      <>{line.map((n, i) => toReact(n, i))}</>
    ));
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
const VIRTUAL_THRESHOLD = 500;
const LINE_H = 20; // 12.5px × 1.6 line-height
const PRE_PAD = 12; // 0.75rem pre padding
const OVERSCAN = 25;

function useLineWindow(
  preRef: RefObject<HTMLPreElement | null>,
  total: number,
  enabled: boolean,
): { start: number; end: number } {
  // Disabled → everything; enabled → nothing until the first measure, so the
  // initial commit never mounts thousands of rows.
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
      const first = Math.floor((scrollTop - preTop - PRE_PAD) / LINE_H);
      const start = Math.max(0, first - OVERSCAN);
      const end = Math.min(
        total,
        Math.max(first, 0) + Math.ceil(viewH / LINE_H) + OVERSCAN * 2,
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
  }, [enabled, total, preRef]);
  return win;
}

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
  const lines = useMemo(() => linesFor(code, language), [code, language]);
  const preRef = useRef<HTMLPreElement>(null);
  const virtual = lines.length >= VIRTUAL_THRESHOLD;
  const { start, end } = useLineWindow(preRef, lines.length, virtual);
  // Numbers are rendered as text, not CSS counters: rows outside the window
  // do not exist, so a counter would restart at the window's edge.
  const digits = String(lines.length).length;
  const slice = virtual ? lines.slice(start, end) : lines;
  return (
    <pre
      ref={preRef}
      className={cn(
        "diff-hl m-0",
        virtual ? "virt" : "whitespace-pre-wrap break-words",
        showLineNumbers && "show-ln",
        className,
      )}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
        lineHeight: "1.6",
        background: "transparent",
        padding: "0.75rem",
        ["--ln-digits" as string]: digits,
      }}
    >
      <code
        style={
          virtual
            ? {
                paddingTop: start * LINE_H,
                paddingBottom: (lines.length - end) * LINE_H,
              }
            : undefined
        }
      >
        {slice.map((node, idx) => {
          const i = virtual ? start + idx : idx;
          return (
            <span key={i} className="line" data-ln={i + 1}>
              {showLineNumbers ? <span className="ln">{i + 1}</span> : null}
              <span className="cl">{node}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

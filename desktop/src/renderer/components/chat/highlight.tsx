/**
 * Per-line syntax highlighting for diff rows. react-syntax-highlighter renders
 * a whole block at once, which can't be interleaved with per-row diff chrome —
 * so we tokenize with refractor (the same engine it uses under the hood) and
 * split the token tree into one ReactNode per source line. Token colours come
 * from the `.diff-hl .token.*` rules in globals.css (tuned to match the
 * oneDark / oneLight themes the plain CodeBlock uses).
 *
 * Functions only, deliberately: the component that draws a block lives in
 * HighlightedCode.tsx. A module that exports both cannot be hot-updated —
 * React Fast Refresh reloads the page instead, and the conversation on screen
 * goes with it.
 */

import { useEffect, useState, type ReactNode } from "react";
import refractor from "refractor";
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

/** Whether refractor can highlight this language at all. */
export function canHighlight(language: string): boolean {
  return isLanguageKnown(language);
}

/**
 * The flat tokens themselves, one array per line.
 *
 * The editor needs these rather than elements: Monaco paints its own text and
 * only asks where each token starts and what it is. Same tokenizer as the
 * chat's code blocks, so a `.tex` file and a ```latex block in a message are
 * coloured by the same rules.
 */
export function tokenizeLines(code: string, language: string): FlatToken[][] {
  const plain = (): FlatToken[][] =>
    code.split("\n").map((l) => [{ cls: "", text: l }]);
  if (!isLanguageKnown(language)) return plain();
  try {
    return splitIntoLines(tokenize(code, language));
  } catch {
    return plain();
  }
}

export type { FlatToken };

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
 * A code block, highlighted — for the CHAT, where blocks are short and there
 * is nothing to virtualize.
 *
 * The file viewer used to share this component, which is why it grew a
 * windowed renderer, a block tokenizer, an idle scheduler and a sticky rows
 * layer. That is Monaco's job now (components/CodeEditor.tsx), and all of it
 * is gone. What is left is what a chat bubble needs: tokenize once, cache by
 * content so a re-render costs nothing, and refuse to tokenize something
 * enormous.
 */
const MAX_HIGHLIGHT_CHARS = 120_000;

/** Tokenized lines by content — survives unmounts (a message re-rendering,
 * a panel moving). ReactNodes are immutable, so sharing them is safe. */
const HL_CACHE = new Map<string, ReactNode[]>();
const HL_CACHE_MAX = 40;

export function linesFor(code: string, language: string): ReactNode[] {
  // Small blocks tokenize in microseconds, and a streaming block re-arrives
  // grown on every flush — caching those would only churn the LRU out of the
  // big entries it exists for.
  if (code.length < 2_000) return highlightLines(code, language);
  const key = language + "\u0000" + code;
  const hit = HL_CACHE.get(key);
  if (hit) {
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

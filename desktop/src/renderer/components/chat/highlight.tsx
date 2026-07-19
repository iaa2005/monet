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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import refractor from "refractor";
import { cn } from "@/lib/utils";

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
 */
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
  const lines = useMemo(() => highlightLines(code, language), [code, language]);
  return (
    <pre
      className={cn(
        "diff-hl m-0 whitespace-pre-wrap break-words",
        showLineNumbers && "show-ln",
        className,
      )}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
        lineHeight: "1.6",
        background: "transparent",
        padding: "0.75rem",
      }}
    >
      <code>
        {lines.map((node, i) => (
          <span key={i} className="line">
            <span className="ln" />
            <span className="cl">{node}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

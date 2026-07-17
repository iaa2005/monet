/**
 * Per-line syntax highlighting for diff rows. react-syntax-highlighter renders
 * a whole block at once, which can't be interleaved with per-row diff chrome —
 * so we tokenize with refractor (the same engine it uses under the hood) and
 * split the token tree into one ReactNode per source line. Token colours come
 * from the `.diff-hl .token.*` rules in globals.css (tuned to match the
 * oneDark / oneLight themes the plain CodeBlock uses).
 */

import type { ReactNode } from "react";
import refractor from "refractor";

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

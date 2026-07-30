/**
 * An escaped dollar must not open inline math.
 *
 * Reported as "криво подсвечивает код в просмотре файла". Measured on a real
 * report.tex: `\$10 / млн входных токенов, \$50 / млн выходных токенов` made
 * Prism's LaTeX grammar open an equation at the first dollar and close it at the
 * second, so `\subsection{…}`, `\begin{itemize}` and paragraphs of prose came out
 * as ONE token classed `equation string` — which the palette paints green.
 *
 * The checks run the real grammar, because the claim is about what Prism does
 * with these patterns and not about my reading of them.
 */

import refractor from "refractor";
import { fixLatexEscapedDollar } from "../src/renderer/components/chat/latex-dollar";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

interface Node {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: Node[];
}

const text = (n: Node): string =>
  n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(text).join("");

/** Every token in the tree, as [classes, text]. */
const tokens = (code: string): [string, string][] => {
  const out: [string, string][] = [];
  const walk = (n: Node, chain: string[]): void => {
    if (n.type === "text") return;
    const cls = (n.properties?.className ?? []).filter((c) => c !== "token");
    out.push([[...chain, ...cls].join(" "), text(n)]);
    for (const c of n.children ?? []) walk(c, [...chain, ...cls]);
  };
  for (const n of refractor.highlight(code, "latex") as unknown as Node[])
    walk(n, []);
  return out;
};

const classOf = (code: string, needle: string): string => {
  const hit = tokens(code)
    .filter(([, t]) => t.includes(needle))
    .sort((a, b) => a[1].length - b[1].length)[0];
  return hit?.[0] ?? "(plain)";
};

// ── 1. Before the fix, to prove the fix is what changes it ────────────
//
// The sample matters, and my first one was wrong: `\$10 … \$50` alone does NOT
// reproduce. What closes the run is not the second escaped dollar — the
// pattern's inner `\\[\s\S]` eats that whole pair — but the next UNESCAPED one.
// It takes ordinary maths further down the file, which is what the real
// report.tex has.
const DOC = [
  "Цена \\$10 за миллион токенов, выход \\$50.",
  "\\subsection{Формулы}",
  "Пусть $x = 1$ и всё хорошо.",
  "Программная инженерия и научные исследования.",
].join("\n");

{
  const runaway = tokens(DOC).filter(
    ([cls, t]) => cls.includes("equation") && t.includes("subsection"),
  );
  check(
    // At least one: the run shows up twice, as the outer `equation` element and
    // as the `string` child inside it that carries the colour.
    "unpatched, an escaped dollar swallows the document",
    runaway.length >= 1,
    runaway[0]?.[1].replace(/\n/g, " ⏎ ").slice(0, 64),
  );
  check(
    "and the run is classed `string`, which the palette paints green",
    (runaway[0]?.[0] ?? "").includes("string"),
    runaway[0]?.[0],
  );
}

// ── 2. The fix applies ────────────────────────────────────────────────
check("the grammar is patched", fixLatexEscapedDollar(refractor));
check("and patching twice is harmless", !fixLatexEscapedDollar(refractor));

// ── 3. After ──────────────────────────────────────────────────────────
{
  const all = tokens(DOC);
  check(
    "no equation spans the document any more",
    !all.some(([cls, t]) => cls.includes("equation") && t.includes("subsection")),
    all.filter(([c]) => c.includes("equation")).map(([, t]) => t).join(" | "),
  );
  check(
    "the escaped dollar is a command, as it should be",
    classOf(DOC, "\\$").includes("function"),
    classOf(DOC, "\\$"),
  );
  // The whole point: the heading gets its own colour back.
  check(
    "the subsection heading is a headline again",
    classOf(DOC, "Формулы").includes("headline"),
    classOf(DOC, "Формулы"),
  );
  check(
    "and the prose is plain text",
    classOf(DOC, "научные исследования") === "(plain)",
    classOf(DOC, "научные исследования"),
  );
  // The real maths in the same document must still be maths.
  check(
    "the genuine equation still highlights",
    classOf(DOC, "x = 1").includes("equation"),
    classOf(DOC, "x = 1"),
  );
}

// ── 4. Real maths must still highlight ────────────────────────────────
{
  const inline = "Пусть $x = 1$ и всё хорошо.";
  check(
    "inline math is still an equation",
    classOf(inline, "x = 1").includes("equation"),
    classOf(inline, "x = 1"),
  );
  check(
    "and it does not leak past its closing dollar",
    classOf(inline, "всё хорошо") === "(plain)",
    classOf(inline, "всё хорошо"),
  );
  const display = "Формула:\n$$\\int_0^1 x\\,dx = \\tfrac12$$\nдалее текст.";
  check(
    "display math too",
    classOf(display, "int_0^1").includes("equation"),
    classOf(display, "int_0^1"),
  );
  check(
    "and it stops at the closing pair",
    classOf(display, "далее текст") === "(plain)",
    classOf(display, "далее текст"),
  );
  // A dollar that opens nothing must not eat the rest of the file either.
  const lone = "Стоит \\$5 и точка.\n\\section{Дальше}\nтекст";
  check(
    "a single escaped dollar leaves the next section alone",
    classOf(lone, "Дальше").includes("headline"),
    classOf(lone, "Дальше"),
  );
}

// ── 5. Nothing else moved ─────────────────────────────────────────────
{
  const doc = "% комментарий\n\\begin{itemize}\n\\item \\textbf{Класс:} значение\n\\end{itemize}";
  check("comments still highlight", classOf(doc, "комментарий").includes("comment"));
  check("keywords still highlight", classOf(doc, "itemize").includes("keyword"));
  check("commands still highlight", classOf(doc, "\\textbf").includes("function"));
  check("braces are still punctuation", classOf(doc, "{") === "punctuation");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL LATEX-DOLLAR CHECKS PASSED");
process.exit(failures ? 1 : 0);

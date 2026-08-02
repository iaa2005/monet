/**
 * A price is not an equation.
 *
 * remark-math opens inline maths at any `$` that is followed by a non-space and
 * closes it at the next `$` that is preceded by one. A model writing about
 * money hits that constantly: "$5, а вот это $10" parses as the maths
 * `5, а вот это ` — and the sentence between two prices comes out in KaTeX
 * italics. Measured on the real pipeline, not guessed:
 *
 *   "Стоит $5, а вот это $10"        → inlineMath "5, а вот это "
 *   "Итого: $1,000 и $2,000 за год"  → inlineMath "1,000 и "
 *   "$100 in, $200 out, $300 total"  → inlineMath "100 in, "
 *
 * So a `$` that opens something with no maths in it is escaped before the
 * parser sees it. The test for "maths in it" is deliberately narrow — the
 * things that only appear in formulas:
 *
 *   \  ^  _  {  }  =        a command, a script, a group, an equality
 *   digit next to a letter  `2x`, `3n`
 *
 * That keeps `$x = 1$`, `$E = mc^2$` and `$2x + 1$` as maths, and turns
 * `$5 / млн`, `$1,000` and `$20` back into text. Only a `$` FOLLOWED BY A
 * DIGIT is considered at all: currency is written that way and a formula
 * starting with a bare number is rare enough to be worth losing to a rule
 * this simple.
 *
 * Code is left alone — fenced blocks and inline spans mean what they say, and
 * a backslash added inside one would be visible.
 */

/** Only what cannot be prose. */
const MATHS_INSIDE = /[\\^_{}=]|\d\s*[A-Za-z]/;

/**
 * Escape the dollars that are prices, in one stretch of prose (no code).
 *
 * Walks left to right so that a `$` already consumed as the close of a real
 * maths span is never reconsidered as an opener.
 */
function escapeInProse(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    // Already escaped by the author, or a display block: not ours.
    if (text[i - 1] === "\\" || text[i + 1] === "$") {
      out += ch;
      i += 1;
      continue;
    }
    if (!/\d/.test(text[i + 1] ?? "")) {
      out += ch;
      i += 1;
      continue;
    }
    // A candidate opener. Where would remark-math close it?
    const close = findCloser(text, i);
    const body = close < 0 ? "" : text.slice(i + 1, close);
    if (close >= 0 && MATHS_INSIDE.test(body)) {
      // Real maths — copy the whole span through untouched.
      out += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += "\\$";
    i += 1;
  }
  return out;
}

/** The `$` that would close a span opened at `from`, or -1. */
function findCloser(text: string, from: number): number {
  for (let j = from + 1; j < text.length; j++) {
    if (text[j] === "\n" && text[j + 1] === "\n") return -1; // maths is inline
    if (text[j] !== "$" || text[j - 1] === "\\") continue;
    // remark-math (Pandoc's rule): the closer must not follow whitespace.
    if (/\s/.test(text[j - 1] ?? "")) continue;
    return j;
  }
  return -1;
}

/**
 * The same, over a whole document, skipping code.
 *
 * Fences are tracked by their own marker so that a ``` inside a ~~~ block does
 * not end it, and inline spans by their backtick run length — the rules
 * markdown itself uses.
 */
export function escapeCurrencyDollars(markdown: string): string {
  if (!markdown.includes("$")) return markdown;

  const lines = markdown.split("\n");
  let fence: string | null = null;
  const out: string[] = [];

  for (const line of lines) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (opener && line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1][0].repeat(3);
      out.push(line);
      continue;
    }
    out.push(escapeOutsideInlineCode(line));
  }
  return out.join("\n");
}

/** One line: transform the prose between inline code spans. */
function escapeOutsideInlineCode(line: string): string {
  if (!line.includes("$")) return line;
  if (!line.includes("`")) return escapeInProse(line);

  let out = "";
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf("`", i);
    if (tick < 0) {
      out += escapeInProse(line.slice(i));
      break;
    }
    out += escapeInProse(line.slice(i, tick));
    const run = /^`+/.exec(line.slice(tick))![0];
    const end = line.indexOf(run, tick + run.length);
    if (end < 0) {
      // An unclosed span is not a span; the rest is prose.
      out += escapeInProse(line.slice(tick));
      break;
    }
    out += line.slice(tick, end + run.length);
    i = end + run.length;
  }
  return out;
}

/**
 * Plain typed text → the few rich pieces worth drawing in a user bubble.
 *
 * The user's own message is NOT markdown: a line starting with `#` is a
 * hash, `*` is an asterisk, and a link is a link because it looks like one.
 * Turning it into a document would rewrite what someone typed. But three
 * things are unambiguously notation and read terribly as literal text:
 *
 *   ```fenced code```   — a block, with its language
 *   `inline code`       — a span
 *   $maths$ / $$maths$$ — a formula
 *
 * So this splits a string into exactly those, leaving everything else
 * verbatim. Precedence is source order with CODE FIRST: a `$` inside a code
 * span is a dollar, and a fence swallows whatever is between its markers —
 * the same rule every markdown parser follows, and the reason `$5` in a
 * price list never becomes a formula.
 *
 * The maths test is borrowed from lib/currency-dollars.ts, which was tuned
 * on the real failure ("Стоит $5, а вот это $10" parsed as one formula):
 * a `$…$` span counts as maths only when it contains something that cannot
 * be prose.
 */

/** Only what cannot be prose — see currency-dollars.ts for the measurements. */
const MATHS_INSIDE = /[\\^_{}=]|\d\s*[A-Za-z]/;

export type RichSegment =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "fence"; value: string; lang: string }
  | { kind: "math"; value: string; display: boolean };

/** Is this `$…$` body a formula rather than a pair of prices? */
export function looksLikeMaths(body: string): boolean {
  const t = body.trim();
  if (!t) return false;
  // A span that spills over a blank line is not a formula, it is two
  // paragraphs that happen to contain dollars.
  if (/\n\s*\n/.test(t)) return false;
  return MATHS_INSIDE.test(t);
}

export function parseRichText(input: string): RichSegment[] {
  const out: RichSegment[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ kind: "text", value: buf });
    buf = "";
  };
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);

    // ``` fenced block ```
    const fence = /^```([^\n`]*)\n?([\s\S]*?)```/.exec(rest);
    if (fence) {
      flush();
      out.push({
        kind: "fence",
        lang: fence[1].trim(),
        value: fence[2].replace(/\n$/, ""),
      });
      i += fence[0].length;
      continue;
    }

    // `inline code` — never spans a blank line (that is a stray backtick).
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: "code", value: code[1] });
      i += code[0].length;
      continue;
    }

    // $$ display maths $$
    const display = /^\$\$([\s\S]+?)\$\$/.exec(rest);
    if (display && looksLikeMaths(display[1])) {
      flush();
      out.push({ kind: "math", value: display[1].trim(), display: true });
      i += display[0].length;
      continue;
    }

    // $ inline maths $ — opener must not be followed by a space, closer must
    // not be preceded by one; that is remark-math's own rule, and it is what
    // keeps "от $5 до $10" out of the formula path even before the maths test.
    if (rest[0] === "$" && rest[1] !== "$" && input[i - 1] !== "\\") {
      const inline = /^\$(\S[^$\n]*?)\$/.exec(rest);
      if (inline && !/\s$/.test(inline[1]) && looksLikeMaths(inline[1])) {
        flush();
        out.push({ kind: "math", value: inline[1].trim(), display: false });
        i += inline[0].length;
        continue;
      }
    }

    buf += input[i];
    i += 1;
  }
  flush();
  return out;
}

/** Does this text hold anything worth rich-rendering at all? */
export function hasRichText(input: string): boolean {
  return parseRichText(input).some((s) => s.kind !== "text");
}

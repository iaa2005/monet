/**
 * A price stays a price, and a formula stays a formula.
 *
 * This runs the REAL markdown pipeline — the same remark-parse / remark-gfm /
 * remark-math the chat renders with — and asks what it produced. Checking the
 * transform's output text would only prove the transform does what it says;
 * what matters is what the parser then makes of it, and the bug was entirely
 * in that step.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import { escapeCurrencyDollars } from "../src/renderer/lib/currency-dollars";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

/** Every maths node the pipeline finds in a document. */
function mathsIn(markdown: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(markdown);
  const found: string[] = [];
  visit(tree, (node: { type: string; value?: string }) => {
    if (node.type === "inlineMath" || node.type === "math")
      found.push(node.value ?? "");
  });
  return found;
}

const through = (markdown: string): string[] =>
  mathsIn(escapeCurrencyDollars(markdown));

// ── Money, as a model writes it ───────────────────────────────────────
//
// Each of these produced maths before the transform; the string in the
// comment is what the parser used to make of it.
{
  const prices: [string, string][] = [
    ["Стоит $5, а вот это $10", "5, а вот это "],
    ["Итого: $1,000 и $2,000 за месяц", "1,000 и "],
    ["$100 in, $200 out, $300 total", "100 in, "],
    ["$10 / млн входных токенов, $50 / млн выходных", "10 / млн входных токенов, "],
    ["цена — $5\nи ещё $7", "5\nи ещё "],
  ];
  for (const [text, wasParsedAs] of prices) {
    check(
      `prices stay prose: ${JSON.stringify(text.slice(0, 34))}`,
      through(text).length === 0,
      { used_to_be: wasParsedAs, now: through(text) },
    );
  }
  check("a single price was never maths anyway", through("Цена $5 за штуку").length === 0);
}

// ── Maths, which must survive untouched ───────────────────────────────
{
  const formulas: [string, string][] = [
    ["Формула $x = 1$ здесь", "x = 1"],
    ["Проверь $E = mc^2$ и заплати $20", "E = mc^2"],
    ["Пусть $2x + 1 = 5$", "2x + 1 = 5"],
    ["Индекс $a_1$ и степень $b^2$", "a_1"],
    ["Дробь $\\frac{1}{2}$", "\\frac{1}{2}"],
  ];
  for (const [text, expected] of formulas) {
    const got = through(text);
    check(
      `maths survives: ${JSON.stringify(text.slice(0, 30))}`,
      got.includes(expected),
      got,
    );
  }
  check(
    "a display block is untouched",
    through("Блок:\n\n$$\na^2 + b^2 = c^2\n$$\n").join("") === "a^2 + b^2 = c^2",
  );
  check(
    "and a formula next to a price keeps only the formula",
    through("Проверь $E = mc^2$ и заплати $20").length === 1,
  );
}

// ── Code says what it says ────────────────────────────────────────────
//
// A backslash added inside a code span or fence would be VISIBLE, which is a
// worse bug than the one being fixed.
{
  const fenced = ["```bash", "echo $5 and $10", "```"].join("\n");
  check("a fenced block is passed through byte for byte", escapeCurrencyDollars(fenced) === fenced, escapeCurrencyDollars(fenced));

  const tilde = ["~~~", "cost=$5, total=$10", "~~~"].join("\n");
  check("so is a tilde fence", escapeCurrencyDollars(tilde) === tilde);

  const inline = "Set `PRICE=$5` and `TOTAL=$10` first";
  check("an inline code span is left alone", escapeCurrencyDollars(inline) === inline, escapeCurrencyDollars(inline));

  const mixed = "Costs $5 total, run `echo $5` to see";
  const out = escapeCurrencyDollars(mixed);
  check(
    "prose around a code span is still fixed",
    out.includes("\\$5 total") && out.includes("`echo $5`"),
    out,
  );
}

// ── Leaving well alone ────────────────────────────────────────────────
{
  check(
    "a document with no dollars is returned unchanged",
    escapeCurrencyDollars("# hi\n\nplain text") === "# hi\n\nplain text",
  );
  const already = "Costs \\$5 and \\$10";
  check("an author's own escape is not doubled", escapeCurrencyDollars(already) === already, escapeCurrencyDollars(already));
}

console.log(
  failures === 0 ? "\nALL CURRENCY-DOLLAR CHECKS PASSED" : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);

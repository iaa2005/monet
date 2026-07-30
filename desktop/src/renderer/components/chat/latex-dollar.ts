/**
 * Prism's LaTeX grammar opens inline math at any `$` — including the `\$` that
 * means a literal dollar sign.
 *
 * Reported as "криво подсвечивает код в просмотре файла", and measured on a real
 * report.tex. The file says `\$10 / млн входных токенов, \$50 / млн выходных`,
 * and further down has ordinary maths, `$x = 1$`. The grammar opens an equation
 * at the dollar inside `\$10`. What closes it is NOT the dollar in `\$50` — the
 * pattern's inner `\\[\s\S]` swallows that whole escape pair — but the next
 * UNESCAPED dollar, pages later. Everything between, `\subsection{…}`,
 * `\begin{itemize}` and paragraphs of prose, comes out as ONE token classed
 * `equation string`, and the palette paints `.token.string` green.
 *
 * The pattern already skips escaped characters INSIDE math. It just never checks
 * whether the OPENING dollar is itself escaped, and a lookbehind fixes exactly
 * that.
 *
 * Patched by exact substring rather than by rewriting the regex: an earlier
 * attempt did string surgery with regexes and matched nothing through the layers
 * of escaping, silently doing no work. If a future refractor ships a different
 * pattern this finds nothing and leaves it alone, which is the right way round
 * for a module every language shares.
 */

/** What the edits look for, as the characters appear in the pattern's source. */
const DISPLAY_OPEN = "\\$\\$"; // the source begins with `\$\$`
const INLINE_OPEN = "|\\$(?:"; // the inline alternative starts after a `|`
/** A `$` not preceded by a backslash, as regex source. */
const LOOKBEHIND = "(?<!\\\\)";

interface EquationRule {
  pattern?: RegExp;
}
interface Refractor {
  languages?: Record<string, { equation?: EquationRule[] } | undefined>;
}

/**
 * True when the grammar was changed. False means already patched, or not the
 * pattern this knows how to fix — both of which mean "leave it alone".
 */
export function fixLatexEscapedDollar(refractor: unknown): boolean {
  const rule = (refractor as Refractor)?.languages?.latex?.equation?.[0];
  const src = rule?.pattern?.source;
  if (!rule?.pattern || !src) return false;
  if (src.includes(LOOKBEHIND)) return false;

  const inline = src.indexOf(INLINE_OPEN);
  if (!src.startsWith(DISPLAY_OPEN) || inline < 0) return false;

  const patched =
    LOOKBEHIND +
    src.slice(0, inline + 1) + // up to and including the `|`
    LOOKBEHIND +
    src.slice(inline + 1);

  try {
    rule.pattern = new RegExp(patched, rule.pattern.flags);
  } catch {
    return false;
  }
  return true;
}

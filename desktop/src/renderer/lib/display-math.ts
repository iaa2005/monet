/**
 * $$formula$$ on its own line → a real display block.
 *
 * remark-math only treats $$…$$ as DISPLAY math when the fences sit on their
 * own lines; a single-line `$$E=mc^2$$` parses as inline math, so KaTeX sets
 * it small and left-bound and the centring people expect never happens.
 * Models write the single-line form constantly.
 *
 * The promotion is deliberately narrow: only a line that is NOTHING BUT one
 * $$…$$ expression is rewritten to the fenced form. Math inside a sentence
 * stays inline (that is what inline means), code fences are untouched, and
 * a line with two $$…$$ groups is prose about dollars, not a formula.
 */

const ONLY_MATH = /^(\s*)\$\$([^$]+?)\$\$\s*$/;

export function promoteDisplayMath(markdown: string): string {
  if (!markdown.includes("$$")) return markdown;
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = ONLY_MATH.exec(line);
      if (!m) return line;
      return `${m[1]}$$\n${m[1]}${m[2].trim()}\n${m[1]}$$`;
    })
    .join("\n");
}

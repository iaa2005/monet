/**
 * Telling YAML frontmatter from a horizontal rule.
 *
 * A file that opens with `---` is usually declaring metadata. A chat message
 * that opens with `---` is usually just drawing a line before the answer —
 * and the old rule ("starts with ---, ends at the next ---") turned everything
 * up to the next rule into a yaml code block. A report that began with a rule
 * and used another one further down had its whole introduction — headings,
 * bold text, prose — rendered as source.
 *
 * So the block has to look like YAML as well as sit where YAML sits: at least
 * one `key: value` at the top level, and nothing that clearly is not YAML.
 * Prose fails on the first sentence, which is the whole point.
 */

/** A top-level `key:` — with or without a value on the same line. */
const KEY_LINE = /^[A-Za-z_][\w.\- ]*:(\s|$)/;
/** `- item`, `- key: value`, or a bare `-`. */
const LIST_LINE = /^\s*-(\s|$)/;
/** A comment, or an indented continuation of the key above. */
const COMMENT_LINE = /^\s*#/;
const INDENTED_LINE = /^\s+\S/;

/** Does this block read as YAML rather than as the start of a document? */
export function looksLikeYaml(block: string): boolean {
  const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  let keys = 0;
  for (const line of lines) {
    if (KEY_LINE.test(line)) {
      keys++;
      continue;
    }
    if (LIST_LINE.test(line) || COMMENT_LINE.test(line) || INDENTED_LINE.test(line))
      continue;
    return false;
  }
  return keys > 0;
}

export interface SplitMarkdown {
  /** The frontmatter block, or null when the document has none. */
  frontmatter: string | null;
  /** Everything else — the whole input when there is no frontmatter. */
  body: string;
}

/** Split a document into frontmatter and body, leaving rules alone. */
export function splitFrontmatter(raw: string): SplitMarkdown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: null, body: raw };
  const block = m[1].trimEnd();
  if (!looksLikeYaml(block)) return { frontmatter: null, body: raw };
  return { frontmatter: block, body: m[2] };
}

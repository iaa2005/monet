/**
 * Reading and writing Obsidian notes — the pure part.
 *
 * A vault is plain Markdown; what makes it a VAULT is three conventions this
 * module understands so the tools can speak them natively:
 *
 *   - wikilinks: [[Note]], [[Note|shown text]], [[Note#heading]] — links by
 *     NOTE NAME, not by path. The whole toolset addresses notes the same way,
 *     because that is the vocabulary the vault itself is written in.
 *   - frontmatter: a YAML-ish block of key: value pairs (tags, aliases, …).
 *     Parsed leniently — real vaults contain hand-typed YAML.
 *   - tags: #tag in the body, or `tags:` in frontmatter.
 *
 * No filesystem access here: parsing is the part a probe pins down, and the
 * file walking lives in index.ts where it can be lazy and incremental.
 */

export interface NoteMeta {
  /** Note name — the basename without .md, how wikilinks address it. */
  name: string;
  /** Vault-relative path, forward slashes. */
  relPath: string;
  /** Outgoing wikilink targets (names, deduplicated, #heading stripped). */
  links: string[];
  /** Tags from body and frontmatter, without '#', lower-case, deduplicated. */
  tags: string[];
  /** Frontmatter aliases — alternative names wikilinks may use. */
  aliases: string[];
  /** Raw frontmatter lines (without the --- fences), "" when absent. */
  frontmatter: string;
  /** First non-heading, non-empty body line — the one-line summary. */
  firstLine: string;
}

/** Split a note into frontmatter (without fences) and body. */
export function splitNote(raw: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { frontmatter: "", body: raw };
  return { frontmatter: m[1], body: raw.slice(m[0].length) };
}

/** Wikilink targets in a text. [[Note|alias]] → Note; [[Note#h]] → Note.
 * Embeds (![[image.png]]) are links to attachments, not notes — skipped. */
export function parseWikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    if (m[1] === "!") continue;
    const name = m[2].trim();
    if (name) out.add(name);
  }
  return [...out];
}

/** #tags in a body. Skips headings (# Title) and anything inside code fences. */
export function parseBodyTags(body: string): string[] {
  const out = new Set<string>();
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A tag is #word after whitespace or line start — never a heading, never
    // the fragment of a URL (…/page#anchor has no space before the #).
    for (const m of line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
      if (/^\d+$/.test(m[1])) continue; // "#42" is an issue number, not a tag
      out.add(m[1].toLowerCase());
    }
  }
  return [...out];
}

/** One frontmatter list value: `key: [a, b]`, `key: a, b`, or a `- a` block. */
export function parseFrontmatterList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, "i").exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline && inline !== "[]") {
      for (const part of inline.replace(/^\[|\]$/g, "").split(","))
        if (part.trim()) out.push(part.trim().replace(/^["']|["']$/g, ""));
    } else {
      // Block list on the following lines.
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s+(.+)$/.exec(lines[j]);
        if (!item) break;
        out.push(item[1].trim().replace(/^["']|["']$/g, ""));
      }
    }
    break;
  }
  return out;
}

/** Everything the index keeps about one note. */
export function parseNote(relPath: string, raw: string): NoteMeta {
  const { frontmatter, body } = splitNote(raw);
  const name = noteNameOf(relPath);
  const fmTags = parseFrontmatterList(frontmatter, "tags").map((t) =>
    t.replace(/^#/, "").toLowerCase(),
  );
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ?? "";
  return {
    name,
    relPath,
    links: parseWikilinks(body),
    tags: [...new Set([...fmTags, ...parseBodyTags(body)])],
    aliases: parseFrontmatterList(frontmatter, "aliases"),
    frontmatter,
    firstLine: firstLine.slice(0, 200),
  };
}

/** The wikilink name of a file: basename, extension dropped. */
export function noteNameOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

/** Case-insensitive key wikilinks resolve through. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A new note, assembled the way Obsidian expects it. */
export function composeNote(opts: {
  body: string;
  tags?: string[];
  aliases?: string[];
  extraFrontmatter?: string;
}): string {
  const fm: string[] = [];
  if (opts.tags?.length) fm.push(`tags: [${opts.tags.join(", ")}]`);
  if (opts.aliases?.length) fm.push(`aliases: [${opts.aliases.join(", ")}]`);
  if (opts.extraFrontmatter?.trim()) fm.push(opts.extraFrontmatter.trim());
  const head = fm.length ? `---\n${fm.join("\n")}\n---\n\n` : "";
  return head + opts.body.replace(/\s+$/, "") + "\n";
}

/** Is this filename a note the index should see at all? */
export function isNoteFile(name: string): boolean {
  return /\.md$/i.test(name);
}

/** Folders a vault walk never enters. */
export const SKIP_DIRS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "node_modules",
  ".vault-meta",
]);

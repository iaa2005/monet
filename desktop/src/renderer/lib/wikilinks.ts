/**
 * [[Wikilinks]] in chat text → real links.
 *
 * The vault protocol tells the model to CITE notes as [[wikilinks]], and a
 * citation you cannot click is a dead end. Markdown knows nothing about the
 * [[..]] syntax, so before parsing, wikilinks become ordinary links with a
 * private scheme — `monet-vault://<encoded ref>` — that MarkdownViewer's
 * link renderer resolves through the vault index on click.
 *
 * The transform must never touch code: `[[x]]` inside a fence or an inline
 * span is someone's array literal, not a citation. Fences are tracked per
 * line; inline code is split out per segment. Embeds (![[img]]) and
 * already-linked text ([...](...)) pass through untouched.
 */

export const VAULT_SCHEME = "monet-vault://";
/** `![[file]]` — an attachment, drawn rather than linked. Its own scheme so
 * the renderer can tell an embed from a citation by the href alone. */
export const VAULT_EMBED_SCHEME = "monet-embed://";

const WIKI_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

function transformSegment(text: string): string {
  return text.replace(
    WIKI_RE,
    (whole, target: string, alias: string | undefined, offset: number) => {
      // An embed is an attachment: the file itself, drawn in place.
      if (offset > 0 && text[offset - 1] === "!") {
        const file = target.trim();
        if (!file) return whole;
        // The "!" stays in the text before this match, so the link replaces
        // only the [[…]] part — the renderer strips the leading "!".
        return `[${file}](${VAULT_EMBED_SCHEME}${encodeURIComponent(file)})`;
      }
      const ref = target.trim();
      if (!ref) return whole;
      const shown = (alias ?? ref.replace(/#.*$/, "")).trim();
      // The #heading part travels in the ref (the resolver strips it), the
      // shown text never carries it unless the user aliased it in.
      return `[${shown}](${VAULT_SCHEME}${encodeURIComponent(ref)})`;
    },
  );
}

/** Transform one line, skipping inline `code` spans. */
function transformLine(line: string): string {
  if (!line.includes("[[")) return line;
  // Split on inline code spans; even indices are prose, odd are code.
  const parts = line.split(/(`+[^`]*`+)/);
  return parts
    .map((part, i) => (i % 2 === 0 ? transformSegment(part) : part))
    .join("");
}

/** The whole-document pass: fences excluded, everything else per line. */
export function linkifyWikilinks(markdown: string): string {
  if (!markdown.includes("[[")) return markdown;
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : transformLine(line);
    })
    .join("\n");
}

/** The note ref a monet-vault:// href carries, or null. */
export function vaultRefFromHref(href: string): string | null {
  if (!href.startsWith(VAULT_SCHEME)) return null;
  try {
    return decodeURIComponent(href.slice(VAULT_SCHEME.length));
  } catch {
    return null;
  }
}

/** The attachment name a monet-embed:// src carries, or null. Because the
 * "!" survives the transform, markdown parses these as IMAGES — so this is
 * read from an <img src>, and the renderer swaps in the real media. */
export function vaultEmbedFromHref(href: string): string | null {
  if (!href.startsWith(VAULT_EMBED_SCHEME)) return null;
  try {
    return decodeURIComponent(href.slice(VAULT_EMBED_SCHEME.length));
  } catch {
    return null;
  }
}

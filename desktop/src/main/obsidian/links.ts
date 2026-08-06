/**
 * Rewriting the references to a file that moved.
 *
 * Obsidian updates links when you rename something inside it; a vault this
 * app moves files in has to do the same, or every embed pointing at the old
 * name goes dead the moment a picture is tidied out of the root.
 *
 * Only the NAME is rewritten, never the surrounding text: `[[old]]`,
 * `[[old|shown]]`, `[[old#heading]]`, `![[old]]` and the path forms
 * (`[[folder/old]]`) all keep their shape. Markdown links to the same file
 * (`![alt](folder/old.png)`) are rewritten too — a vault written by hand
 * often mixes both.
 *
 * Pure string work: what a probe can pin down, and what must not depend on
 * a filesystem to be trusted.
 */

/** Escape a string for use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RenameSpec {
  /** The name (or vault-relative path) references currently use. */
  from: string;
  /** What they should say instead. */
  to: string;
}

/**
 * Rewrite every reference to `from` in one note's text.
 *
 * Matching is case-insensitive on the name, the way Obsidian resolves —
 * and it accepts both the bare name and any path that ENDS with it, so a
 * reference written as `attachments/pic.png` is caught when the file is
 * addressed as `pic.png`.
 */
export function rewriteLinks(text: string, spec: RenameSpec): {
  text: string;
  count: number;
} {
  const fromBase = spec.from.split("/").pop() ?? spec.from;
  const toBase = spec.to.split("/").pop() ?? spec.to;
  let count = 0;

  // [[…]] and ![[…]] — the target is everything before | or #.
  const wiki = new RegExp(
    `(!?\\[\\[)([^\\]|#\\n]+)((?:#[^\\]|\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\])`,
    "g",
  );
  let out = text.replace(wiki, (whole, open: string, target: string, tail: string) => {
    const t = target.trim();
    const tBase = t.split("/").pop() ?? t;
    if (tBase.toLowerCase() !== fromBase.toLowerCase()) return whole;
    count++;
    // A reference written as a path keeps being a path; a bare name stays bare.
    return `${open}${t.includes("/") ? spec.to : toBase}${tail}`;
  });

  // [text](path) and ![alt](path) — only when the path points at the same file.
  const md = new RegExp(`(!?\\[[^\\]\\n]*\\]\\()([^)\\s]+)(\\))`, "g");
  out = out.replace(md, (whole, open: string, url: string, close: string) => {
    if (/^[a-z]+:/i.test(url)) return whole; // http(s):, obsidian:, monet-…
    const uBase = decodeURIComponent(url).split("/").pop() ?? url;
    if (uBase.toLowerCase() !== fromBase.toLowerCase()) return whole;
    count++;
    return `${open}${url.includes("/") ? spec.to : toBase}${close}`;
  });

  return { text: out, count };
}

/** Does this note reference `name` at all? Cheap pre-filter so a rename
 * only rewrites the notes it must touch. */
export function referencesName(text: string, name: string): boolean {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  return text.toLowerCase().includes(base);
}

/** One find-and-replace inside a note, with the same discipline the file
 * Edit tool uses: the old text must appear, and appear once, unless the
 * caller asked for all of them. */
export function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { ok: true; text: string; count: number } | { ok: false; error: string } {
  if (!oldString) return { ok: false, error: "old_string is empty." };
  if (oldString === newString)
    return { ok: false, error: "old_string and new_string are identical." };
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0)
    return {
      ok: false,
      error:
        "old_string was not found in the note. Read it again — whitespace and line breaks must match exactly.",
    };
  if (occurrences > 1 && !replaceAll)
    return {
      ok: false,
      error: `old_string appears ${occurrences} times. Add surrounding context to make it unique, or pass replace_all.`,
    };
  const out = replaceAll
    ? text.split(oldString).join(newString)
    : text.replace(oldString, newString);
  return { ok: true, text: out, count: occurrences };
}

export { esc as escapeRegExp };

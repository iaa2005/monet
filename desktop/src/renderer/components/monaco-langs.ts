/**
 * The languages Monaco does not ship, coloured by the one the app already has.
 *
 * Monaco knows about eighty languages and LaTeX is not one of them — a `.tex`
 * file opened as plaintext, and so did `.toml`, `.nix`, a `.diff`. The chat's
 * code blocks have never had that problem: they go through refractor (Prism),
 * which knows all of them. So rather than hand-writing Monarch grammars, the
 * editor asks the same tokenizer, and a file is coloured exactly like a
 * fenced block of the same language in a message.
 *
 * What is registered is decided at RUNTIME, not written down here: a pair is
 * taken only if refractor knows the language AND no Monaco language already
 * claims the extension. Monaco gains languages between versions; when it
 * gains one of these, its own grammar wins and this quietly stops applying.
 *
 * The one honest limitation: Monaco asks line by line, and this tokenizes line
 * by line, so a construct spanning lines (a verbatim block, a block comment)
 * is coloured per line rather than as a whole. For the languages here that is
 * a rounding error — and the alternative, re-tokenizing the file on every
 * keystroke, is the cost that made the old viewer unusable.
 */

import * as monaco from "monaco-editor";
import { canHighlight, tokenizeLines } from "./chat/highlight";

/** Extensions worth colouring, with the refractor language that does it. */
const CANDIDATES: { lang: string; extensions: string[] }[] = [
  // Delimited text. The colouring is modest by design — quoted fields and
  // the separators — but it is the difference between reading a CSV and
  // counting commas, which is the whole job in text mode.
  { lang: "csv", extensions: [".csv", ".tsv"] },
  { lang: "latex", extensions: [".tex", ".sty", ".cls", ".bib", ".ltx"] },
  { lang: "toml", extensions: [".toml"] },
  { lang: "diff", extensions: [".diff", ".patch"] },
  { lang: "nix", extensions: [".nix"] },
  { lang: "zig", extensions: [".zig"] },
  { lang: "makefile", extensions: [".mk", ".mak"] },
  { lang: "haskell", extensions: [".hs", ".lhs"] },
  { lang: "elm", extensions: [".elm"] },
  { lang: "erlang", extensions: [".erl", ".hrl"] },
  { lang: "ocaml", extensions: [".ml", ".mli"] },
  { lang: "matlab", extensions: [".m"] },
  { lang: "fortran", extensions: [".f90", ".f95", ".f03"] },
  { lang: "verilog", extensions: [".v", ".vh"] },
  { lang: "vhdl", extensions: [".vhd", ".vhdl"] },
  { lang: "groovy", extensions: [".groovy", ".gradle"] },
  { lang: "nginx", extensions: [".nginx"] },
  { lang: "apacheconf", extensions: [".htaccess"] },
  { lang: "properties", extensions: [".properties", ".env"] },
  { lang: "json5", extensions: [".json5"] },
  { lang: "csv", extensions: [".csv", ".tsv"] },
  { lang: "asciidoc", extensions: [".adoc", ".asciidoc"] },
];

/**
 * Prism's token names → the scopes the editor themes already paint.
 *
 * Both base themes (vs, vs-dark) colour a fixed vocabulary; mapping onto it
 * means these languages inherit the app's theme for free instead of shipping
 * a palette of their own. Anything unmapped stays plain text, which is the
 * right answer for a token nobody has decided how to colour.
 */
const SCOPES: Record<string, string> = {
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "string",
  string: "string",
  char: "string",
  url: "string",
  "attr-value": "string",
  // LaTeX: the maths IS the content — give it the string colour and let the
  // command inside it stand out as a regexp.
  equation: "string",
  "equation-command": "regexp",
  regex: "regexp",
  keyword: "keyword",
  atrule: "keyword",
  important: "keyword",
  boolean: "keyword",
  headline: "type.identifier",
  "class-name": "type.identifier",
  table: "type.identifier",
  builtin: "type.identifier",
  function: "keyword",
  number: "number",
  constant: "number",
  date: "number",
  symbol: "number",
  variable: "variable",
  antiquotation: "variable",
  key: "attribute.name",
  "attr-name": "attribute.name",
  property: "attribute.name",
  tag: "tag",
  selector: "tag",
  operator: "delimiter",
  punctuation: "delimiter",
  inserted: "string",
  deleted: "regexp",
};

/** The first mapped class wins; Prism merges several onto one token. */
function scopeFor(classNames: string): string {
  for (const cls of classNames.split(/\s+/)) {
    if (cls === "token" || !cls) continue;
    const scope = SCOPES[cls];
    if (scope) return scope;
  }
  return "";
}

const NO_STATE: monaco.languages.IState = {
  clone: () => NO_STATE,
  equals: () => true,
};

/** Extensions Monaco already owns — its own grammar beats a borrowed one. */
function takenExtensions(): Set<string> {
  const taken = new Set<string>();
  for (const lang of monaco.languages.getLanguages())
    for (const ext of lang.extensions ?? []) taken.add(ext.toLowerCase());
  return taken;
}

let registered = false;

export function registerExtraLanguages(): string[] {
  if (registered) return [];
  registered = true;
  const taken = takenExtensions();
  const added: string[] = [];

  for (const { lang, extensions } of CANDIDATES) {
    if (!canHighlight(lang)) continue;
    const free = extensions.filter((e) => !taken.has(e));
    if (free.length === 0) continue;

    monaco.languages.register({ id: lang, extensions: free });
    monaco.languages.setTokensProvider(lang, {
      getInitialState: () => NO_STATE,
      tokenize: (line) => {
        const tokens: monaco.languages.IToken[] = [];
        let at = 0;
        for (const t of tokenizeLines(line, lang)[0] ?? []) {
          tokens.push({ startIndex: at, scopes: scopeFor(t.cls) });
          at += t.text.length;
        }
        return { tokens, endState: NO_STATE };
      },
    });
    added.push(lang);
  }
  return added;
}

/**
 * Monaco's id for a file name — its own table, extended by the block above.
 *
 * Here rather than next to the editor component because a file that exports
 * a component and a plain function cannot be hot-updated: React Fast Refresh
 * gives up and reloads the page, taking the conversation with it.
 */
export function languageOf(fileName: string): string {
  const ext = "." + (fileName.split(".").pop() ?? "").toLowerCase();
  for (const lang of monaco.languages.getLanguages())
    if (lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  return "plaintext";
}

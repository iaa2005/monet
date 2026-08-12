/**
 * Upstream's own words, in this app's name.
 *
 * The vendored command registry is written for the CLI and says so — "Review a
 * pull request with Claude Code", "create a CLAUDE.md file, which will be
 * given to future instances of Claude Code" — and that text reaches two
 * audiences: the user, through the "/" menu, and the MODEL, through command
 * expansion. Wrong on screen, and wrong in substance: the model answering may
 * be DeepSeek, and the file we prefer to write is our own.
 *
 * Applied on the way OUT rather than edited into the vendor files, because
 * those are replaced wholesale on the next update and would take the edit
 * with them.
 *
 * EVERY NAME COMES FROM shared/brand — none is spelt out here. Renaming the
 * product is then one file, which is the only way a rename ever actually
 * happens.
 *
 * Pure, and separate from its caller, so the rule can be checked without
 * booting Electron. The risk in it is over-reach, not under-reach: "Claude
 * API" is a real product, and mangling it would turn a description into a lie
 * — worse than leaving the wrong brand on it.
 */

import {
  APP_NAME,
  MEMORY_FILE,
  UPSTREAM_API_NAME,
  UPSTREAM_MEMORY_FILE,
  UPSTREAM_NAME,
} from "./brand.js";

/** A constant used inside a RegExp is data, not pattern — "CLAUDE.md" would
 * otherwise match "CLAUDEXmd". */
function literal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The bare product word ("Claude"), taken from the full name rather than
 * written again — this is the token that must NOT be rewritten when it is
 * part of the API's name or the memory file's. */
const VENDOR_WORD = UPSTREAM_NAME.split(" ")[0];
/** What follows the bare word when it belongs to a name we keep: " API",
 * " Code", and the ".md" of the memory file. */
const KEEP_SUFFIX = UPSTREAM_API_NAME.slice(VENDOR_WORD.length).trim();
const MEMORY_SUFFIX = UPSTREAM_MEMORY_FILE.slice(VENDOR_WORD.length);

const PRODUCT = new RegExp(`\\b${literal(UPSTREAM_NAME)}\\b`, "g");
const MEMORY = new RegExp(literal(UPSTREAM_MEMORY_FILE), "g");
const BARE_WORD = new RegExp(
  `\\b${literal(VENDOR_WORD)}\\b` +
    // not "Claude API", not "Claude Code"…
    `(?!\\s+(?:${literal(KEEP_SUFFIX)}|${literal(UPSTREAM_NAME.split(" ")[1] ?? "")})\\b)` +
    // …and not the "CLAUDE" of "CLAUDE.md", whatever its case.
    `(?!${literal(MEMORY_SUFFIX)})`,
  "g",
);

export function rebrand(text: string): string {
  return (
    text
      .replace(PRODUCT, APP_NAME)
      // Our memory file is the one we write when we get to choose; both are
      // still READ (see MEMORY_FILENAMES), so this changes what a command
      // creates, not what it can find.
      .replace(MEMORY, MEMORY_FILE)
      .replace(BARE_WORD, "the agent")
  );
}

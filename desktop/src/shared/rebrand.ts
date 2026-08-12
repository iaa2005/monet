/**
 * The vendor's own words, in this app's name.
 *
 * The leaked command registry is written for the CLI and says so — "Review a
 * pull request with Claude Code", "Set a goal for Claude to work toward" —
 * which is wrong on screen here and wrong in substance: the model answering
 * may be DeepSeek. Applied on the way OUT of the catalog rather than edited
 * into the vendor files, because those are replaced wholesale on the next
 * update and would take the edit with them.
 *
 * Pure and here rather than beside its caller so the rule can be checked
 * without booting Electron — the risk in it is over-reach, not under-reach.
 */

import { APP_NAME } from "./brand.js";

export function rebrand(text: string): string {
  return (
    text
      .replace(/\bClaude Code\b/g, APP_NAME)
      // A bare "Claude" meaning the assistant. Guarded so "Claude API" (a real
      // product) and "CLAUDE.md" (a real file these commands write) are left
      // exactly as they are — renaming either would make the description a lie,
      // which is worse than leaving the wrong brand on it.
      .replace(/\bClaude\b(?!\s+(?:API|Code)\b)(?!\.md)/g, "the agent")
  );
}

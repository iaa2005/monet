/**
 * Lean context — shrink what the model is charged for BEFORE the user's first
 * word, without changing what the tools actually do.
 *
 * Measured on this app (Code space, Windows, `scripts/measure-prompt.mjs`):
 *
 *   system prompt : 6356 tok   of which the vendor auto-memory block is 3146
 *   tool prompts  : 8844 tok   of which Bash 2501, TodoWrite 2279, PowerShell 1684
 *   TOTAL         : 15200 tok  before a single user word
 *
 * Two levers, both measured rather than guessed:
 *
 * 1. Tool prompts keep every RULE and lose the worked EXAMPLES. The examples
 *    are the bulk (TodoWrite is mostly a dark-mode walkthrough) and the rules
 *    are what actually constrains behaviour.
 * 2. The vendor's auto-memory block describes a second, parallel memory system
 *    (daily logs under the vendored config dir) that this app never surfaces —
 *    it has its own memory with its own UI (Settings → Memory). Disabling it
 *    is a startup-time env var: the vendor memoises that section on first
 *    build, so it cannot be toggled mid-process.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface LeanConfig {
  /** Strip worked examples from tool descriptions. */
  leanTools: boolean;
}

const DEFAULT: LeanConfig = { leanTools: true };

function configPath(): string {
  return join(getDataDir(), "lean-context.json");
}

export function getLeanConfig(): LeanConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<LeanConfig>;
    return { leanTools: raw.leanTools !== false };
  } catch {
    return { ...DEFAULT };
  }
}

export function setLeanConfig(patch: Partial<LeanConfig>): LeanConfig {
  const next = { ...getLeanConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

/**
 * Suppress the vendor's own auto-memory instructions. They describe a SECOND
 * memory system (its own directory, its own index) that nothing in this app
 * maintains — the app runs its own daily-log → nightly-consolidation → index
 * memory, so leaving the vendor block in would point the model at a parallel
 * store and waste ~3100 tokens doing it.
 *
 * MUST run before anything builds a system prompt: the vendor caches that
 * section on first computation, so setting it later has no effect until
 * restart (verified: at startup this drops 6356 tok → 3210 tok).
 */
export function applyLeanEnv(): void {
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
}

// ─── Tool description compression ───────────────────────────────────────────

/** Headings that introduce worked examples rather than rules. */
const EXAMPLE_HEADING =
  /^#{1,4}\s*(examples?\b|example[s]?\s|.*\bexamples?\s*(of|when|:)|usage examples?)/i;

/**
 * Drop example blocks, keep rules.
 *
 * Removes `<example>…</example>` blocks and any heading section whose title
 * announces examples, up to the next heading of the same or higher level.
 * Everything else — every NEVER/IMPORTANT/constraint line — survives verbatim,
 * because those are what stop the model doing damage.
 */
export function stripExamples(text: string): string {
  if (!text) return text;

  // <example>…</example> and <good-example>/<bad-example> variants.
  let out = text.replace(
    /<([a-z-]*example[a-z-]*)>[\s\S]*?<\/\1>\s*/gi,
    "",
  );

  const lines = out.split("\n");
  const kept: string[] = [];
  let skipDepth = 0; // heading level being skipped, 0 = not skipping
  for (const line of lines) {
    const heading = /^(#{1,4})\s+/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (skipDepth > 0 && level <= skipDepth) skipDepth = 0; // section ended
      if (skipDepth === 0 && EXAMPLE_HEADING.test(line)) {
        skipDepth = level;
        continue;
      }
    }
    if (skipDepth === 0) kept.push(line);
  }
  out = kept.join("\n");

  // Collapse the runs of blank lines the removals leave behind.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Compress one tool's description when lean mode is on. */
export function leanToolDescription(description: string): string {
  return getLeanConfig().leanTools ? stripExamples(description) : description;
}

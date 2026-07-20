/**
 * Caveman mode (opt-in).
 *
 * OFF by default. When ON, the agent is steered to write SUPER-terse output and
 * thinking (telegraphic, no filler), and context compaction fires earlier and
 * summarizes tighter. Nothing about the toolset or capabilities changes — only
 * the verbosity of the model's prose and how aggressively history is squeezed.
 *
 * The directive text is user-tunable via <dataDir>/prompts/caveman-directive.md.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { tunablePrompt } from "../prompts/index.js";

export interface CavemanConfig {
  enabled: boolean;
}

const DEFAULT: CavemanConfig = { enabled: false };

function configPath(): string {
  return join(getDataDir(), "caveman.json");
}

export function getCavemanConfig(): CavemanConfig {
  try {
    const raw = JSON.parse(
      readFileSync(configPath(), "utf-8"),
    ) as Partial<CavemanConfig>;
    return { enabled: raw.enabled === true };
  } catch {
    return { ...DEFAULT };
  }
}

export function setCavemanConfig(patch: Partial<CavemanConfig>): CavemanConfig {
  const next = { ...getCavemanConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

/** Whether caveman mode is currently on. */
export function isCaveman(): boolean {
  return getCavemanConfig().enabled;
}

/** The terse-style directive, prepended to the system prompt when caveman is on.
 * Tunable via <dataDir>/prompts/caveman-directive.md. */
const CAVEMAN_DIRECTIVE_DEFAULT = [
  "# CAVEMAN MODE",
  "Write like a caveman: maximum signal, minimum words.",
  "- Output: telegraphic. No preamble, no summary, no restating the request, no",
  "  pleasantries. Drop articles and filler where meaning survives. One short",
  "  clause per idea. Prefer a bullet or a fragment over a sentence.",
  "- Thinking: keep reasoning minimal and terse — short fragments, not prose.",
  "- Never explain what you are about to do before doing it; just do it, then",
  "  report the result in as few words as possible.",
  "- Code, file paths, commands and exact quotes stay verbatim — never abbreviate",
  "  those. Terseness applies to YOUR prose, not to the artifacts.",
  "- Still follow every other instruction and safety rule in full.",
].join("\n");

export function cavemanDirective(): string {
  return tunablePrompt("caveman-directive", CAVEMAN_DIRECTIVE_DEFAULT);
}

/**
 * Per-turn reinforcement, appended to the message list right before the model
 * generates.
 *
 * The system prompt is ~6K tokens of instructions and sits behind the whole
 * conversation; by the time the model writes, a style directive that far back
 * competes with everything after it — which is why caveman "worked sometimes".
 * A short reminder adjacent to the generation point is what actually holds.
 * Deliberately tiny (~30 tokens): it is paid on every turn.
 */
export const CAVEMAN_TURN_REMINDER =
  "<system-reminder>CAVEMAN MODE. Answer in the fewest words that carry the " +
  "meaning. No preamble, no restating the task, no closing summary, no " +
  "offers of further help. Fragments over sentences. Code, paths and commands " +
  "stay verbatim.</system-reminder>";

/** Extra instruction appended to the compaction summary request in caveman mode:
 * squeeze harder, keep only load-bearing facts. */
export const CAVEMAN_COMPACT_HINT =
  "Be extremely terse: keep only load-bearing facts, decisions, file paths and " +
  "open threads. Use fragments and bullets, no prose. Drop anything the model " +
  "does not need to continue.";

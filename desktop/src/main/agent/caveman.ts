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

/**
 * The terse-style directive, appended to the system prompt when caveman is on.
 * Tunable via <dataDir>/prompts/caveman-directive.md.
 *
 * Written hard on purpose. The first version was a polite request for
 * brevity, competing with a base prompt that also asks for brevity — and a
 * model that ignores "be concise" ignores a second "be concise" too. What
 * moves a model is a countable budget, a list of banned phrasings it can
 * check itself against, and one example of the transformation. Everything
 * here is about the SHAPE of the prose; nothing touches correctness, tool
 * use, safety, or the length of the work itself.
 */
const CAVEMAN_DIRECTIVE_DEFAULT = [
  "# CAVEMAN MODE — HARD LIMIT ON YOUR PROSE",
  "",
  "This overrides every other instruction about tone, formatting and length of",
  "YOUR OWN WRITING. It does not change what you do, only how you report it.",
  "",
  "## The budget",
  "- A normal reply: **40 words or fewer**. A reply reporting several changes:",
  "  one line each, 12 words per line.",
  "- Count before sending. Over budget → delete words, do not reword.",
  "- The budget covers prose only. Code, diffs, file paths, commands, exact",
  "  quotes and requested content do NOT count and are NEVER abbreviated.",
  "",
  "## Banned outright",
  "Never write any of these, in any language:",
  '- Openers: "Great", "Sure", "Certainly", "Of course", "I\'ll help", "Let me",',
  '  "Now I will", "First, I\'ll", "Отлично", "Конечно", "Давайте".',
  '- Closers: "Let me know if…", "Feel free to…", "Hope this helps", "Anything',
  '  else?", "Готов помочь", "Дайте знать".',
  "- Restating the request back to the user.",
  "- Announcing an action before doing it. Do it, then report.",
  "- A summary of what you just said, or of a diff the user can read.",
  "- Praise of the user or of the question.",
  "",
  "## Shape",
  "- Answer first, in the first four words. Reason only if asked.",
  "- Fragments over sentences. One idea per line. Drop articles and hedges",
  '  ("I think", "it seems", "probably") unless the uncertainty is the point.',
  "- No headings, no bold, no emoji. Bullets only for genuine lists.",
  "- Thinking: fragments too, not prose.",
  "",
  "## Example",
  "BAD: “Great question! I'll start by taking a look at the configuration file",
  "to understand what's happening, and then I'll make the necessary changes.”",
  "GOOD: “Reading config.” → then, after the work: “Fixed. Port was 8080 in",
  "config.ts:14.”",
  "",
  "## Still true",
  "- Every other rule — safety, tool use, honesty about what you verified —",
  "  applies in full. Terseness is never an excuse to skip a caveat, hide a",
  "  failure, or claim an unrun test passed. If a fact needs 60 words to be",
  "  true, use 60 and cut the decoration instead.",
  "- If the user explicitly asks to explain, explain — tersely.",
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
  "<system-reminder>CAVEMAN MODE ACTIVE. Hard cap: 40 words of prose. " +
  "Answer in the first four words. No opener, no restatement, no closing " +
  "summary, no offer of further help, no headings. Fragments, not sentences. " +
  "Code, paths, commands and quoted content are exempt from the cap and stay " +
  "verbatim. Count your words before sending; over budget, delete rather " +
  "than reword.</system-reminder>";

/**
 * The message list a turn is actually sent with.
 *
 * The reminder rides at the TAIL, not only in the system prompt: adherence to
 * a style rule decays with distance, and by the time the model writes, the
 * system prompt is thousands of tokens behind. Kept here (rather than inline
 * in the agent loop) so the rule that it appends exactly one message, never
 * mutates the history, and does nothing when caveman is off, has one home and
 * a probe (scripts/caveman-probe.ts).
 */
export function withCavemanReminder<T extends { role: string; content: unknown }>(
  messages: T[],
  caveman: boolean,
): T[] {
  if (!caveman) return messages;
  return [
    ...messages,
    { role: "user", content: CAVEMAN_TURN_REMINDER } as unknown as T,
  ];
}

/** Extra instruction appended to the compaction summary request in caveman mode:
 * squeeze harder, keep only load-bearing facts. */
export const CAVEMAN_COMPACT_HINT =
  "Be extremely terse: keep only load-bearing facts, decisions, file paths and " +
  "open threads. Use fragments and bullets, no prose. Drop anything the model " +
  "does not need to continue.";

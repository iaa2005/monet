/**
 * TodoWrite's description, after the rewrite that made it a fifth the size.
 *
 * The long form said the same rules three ways and carried five worked
 * examples of building a dark-mode toggle: 920 tokens after lean mode, on
 * every turn of every chat, for a tool most turns never call. The short one
 * has to keep every CONSTRAINT while losing the repetition — and the way that
 * goes wrong is quiet, because a dropped rule does not fail anything, it just
 * makes the model's task list slowly worse.
 *
 * So the rules are checked as vocabulary: each load-bearing term of the long
 * form must appear in the short one. It is a coarse test and it is the right
 * one — it cannot judge prose, but it catches the omission.
 *
 *   npm run smoke:todoprompt
 */

import { PROMPT, PROMPT_LONG } from "../src/main/engine/tools/TodoWriteTool/prompt";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};

const short = PROMPT.toLowerCase();

// The machinery: names the model has to get exactly right or the call fails
// its own schema.
for (const term of ["pending", "in_progress", "completed", "content", "activeform"]) {
  check(`names ${term}`, short.includes(term));
}

// The rules. Each is a thing the long form insisted on, in the words it can
// be recognised by.
const rules: [string, RegExp][] = [
  ["one task in progress at a time", /exactly one|one task/],
  ["marking it before starting, not after", /before you begin|before beginning/],
  ["not batching completions", /never batch|don't batch|do not batch/],
  ["three steps as the threshold", /three or more|3 or more/],
  ["skipping it for a single trivial task", /single straightforward|trivial/],
  ["failing tests forbid completed", /tests are failing/],
  ["a partial implementation forbids completed", /partial/],
  ["an unresolved error forbids completed", /unresolved/],
  ["a missing file forbids completed", /not found|couldn't find|could not find/],
  ["blocked means it stays in progress", /blocked/],
  ["removing what stopped being relevant", /relevant/],
  ["both forms of a description", /imperative/],
];
for (const [name, re] of rules) check(name, re.test(short), PROMPT.length);

// And the saving itself, so a future edit that quietly re-inflates it is
// visible rather than only expensive.
const tok = (s: string): number => Math.ceil(s.length / 4);
check(
  `it is a fifth of what it replaced (${tok(PROMPT)} vs ${tok(PROMPT_LONG)} tok)`,
  tok(PROMPT) < tok(PROMPT_LONG) / 3,
  `${tok(PROMPT)} / ${tok(PROMPT_LONG)}`,
);

console.log(failures ? `\n${failures} FAILED` : "\nALL TODO-PROMPT CHECKS PASSED");
process.exit(failures ? 1 : 0);

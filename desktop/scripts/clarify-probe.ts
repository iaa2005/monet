/**
 * "Ask when it is ambiguous" — the contract around the question.
 *
 * This one spends the most expensive thing the app has: the user's
 * attention. So the interesting cases are all about NOT asking —
 *
 *   - an answer that is neither "CLEAR" nor a well-formed question must not
 *     become a dialog. A half-parsed line is half a question, and a person
 *     staring at half a question is worse off than one never interrupted;
 *   - a greeting, a thank-you or a one-word follow-up is not a brief;
 *   - two questions, maximum, ever. Five is a form.
 *
 *   npm run smoke:clarify
 */

import {
  answersNote,
  clarifyPrompt,
  parseClarify,
  worthClarifying,
  MAX_QUESTIONS,
} from "../src/main/verify/clarify.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

// ─── What the reader is asked ───────────────────────────────────────────

{
  const p = clarifyPrompt("Add auth");
  check("it is told it cannot see the code", /cannot see the code/i.test(p));
  check(
    "…that missing detail is NOT the bar",
    /is there detail missing/i.test(p) && /always is/i.test(p),
  );
  check("…that the bar is two different builds", /two DIFFERENT things/.test(p));
  check("…and to prefer silence when hesitating", /Prefer CLEAR/i.test(p));
  check("the request is in the prompt", p.includes("Add auth"));
}

// ─── What it may answer ─────────────────────────────────────────────────

{
  check("clear is clear", parseClarify("CLEAR").status === "clear");
  check(
    "…even with a sentence around it",
    parseClarify("Nothing forks here. CLEAR").status === "clear",
  );

  const one = parseClarify(
    "ASK Storage | Where should the drafts live? | In the session DB | On disk as files",
  );
  check("a well-formed question is read", one.status === "ask", one);
  check("…with its label", one.questions[0]?.header === "Storage", one.questions[0]);
  check(
    "…its question",
    one.questions[0]?.question === "Where should the drafts live?",
  );
  check("…and both options", one.questions[0]?.options.length === 2, one.questions[0]);

  const messy = parseClarify(
    [
      "Here is the fork I see:",
      "1. ASK **Scope** | Should this apply to Home chats too? | Code only | Both",
      "- ASK  Undo  | Is removing reversible? | Yes, restorable | No, permanent | Ask each time",
    ].join("\n"),
  );
  check("the shapes a model writes are read too", messy.status === "ask", messy);
  check("…and decoration is stripped", messy.questions[0]?.header === "Scope");
  check(
    "…and three options survive",
    messy.questions[1]?.options.length === 3,
    messy.questions[1],
  );

  check(
    "A HALF-WRITTEN QUESTION IS NOT ASKED",
    parseClarify("ASK Storage | Where should the drafts live?").status === "skipped",
    parseClarify("ASK Storage | Where should the drafts live?"),
  );
  check(
    "…nor is a question with one option",
    parseClarify("ASK Storage | Where? | In the DB").status === "skipped",
  );
  check(
    "AN ANSWER THAT IS NEITHER IS NOT 'CLEAR'",
    parseClarify("Sounds like a reasonable request to me!").status === "skipped",
  );
  check("…and neither is silence", parseClarify("").status === "skipped");
  check(
    "and it never asks more than two",
    parseClarify(
      Array.from(
        { length: 5 },
        (_, i) => `ASK L${i} | question ${i}? | option a | option b`,
      ).join("\n"),
    ).questions.length === MAX_QUESTIONS,
  );
}

// ─── When not to bother at all ──────────────────────────────────────────

{
  for (const p of ["hi", "thanks", "ok", "what is this?", "да"])
    check(`a remark is not a brief: "${p}"`, !worthClarifying(p));
  for (const p of [
    "Add a dark mode toggle to the settings page",
    "refactor the session store so it keys by folder",
  ])
    check(`a task is: "${p.slice(0, 34)}…"`, worthClarifying(p));
}

// ─── What the answers become ────────────────────────────────────────────

{
  const note = answersNote([
    { question: "Where should the drafts live?", selected: ["On disk as files"] },
  ]);
  check("the answer rides in with the brief", note.includes("On disk as files"));
  check("…attached to its question", note.includes("Where should the drafts live?"));
  check("…and marked as answered up front", /before the work started/i.test(note));
}

console.log(
  failures ? `\n${failures} FAILED` : "\nIT ASKS ONLY WHEN GUESSING WOULD WASTE THE WORK",
);
process.exit(failures ? 1 : 0);

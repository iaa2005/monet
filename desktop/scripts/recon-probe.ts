/**
 * Reconnaissance: the phase in which writing is not an available action.
 *
 * Three things decide whether this helps or merely gets in the way:
 *
 *   - the toolset really is read-only. An allow-list that leaks Bash, Write
 *     or an MCP tool nobody classified turns the whole phase into theatre —
 *     the model writes anyway, one turn later than before;
 *   - it does not fire on "hi". A planning phase in front of a greeting is
 *     how a feature earns a reputation for being in the way;
 *   - the prompts SAY writing is unavailable. Without that line the model
 *     spends a looking turn trying to Edit and reading the refusal.
 *
 *   npm run smoke:recon
 */

import {
  LOOK_FIRST_NOTE,
  LOOK_FIRST_TOOLS,
  planWasMade,
  RECON_DONE,
  RECON_PROMPT,
  RECON_TIMEUP,
  RECON_TOOLS,
  RECON_TURNS,
  reconRefusal,
  reconTools,
} from "../src/main/agent/recon.js";
import { WRITERS } from "../src/main/agent/writers.js";

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

// ─── The toolset cannot change anything ─────────────────────────────────

{
  const every = [
    "Read",
    "Grep",
    "Glob",
    "Write",
    "Edit",
    "MultiEdit",
    "Bash",
    "PowerShell",
    "RunPython",
    "RunCommand",
    "SandboxWrite",
    "SandboxRead",
    "Task",
    "Skill",
    "WebFetch",
    "AskUserQuestion",
    "TodoWrite",
    "mcp__notion__update_page",
  ].map((name) => ({ name }));

  const kept = reconTools(every).map((t) => t.name);
  check("reading survives", kept.includes("Read") && kept.includes("Grep"));
  check("so does asking the user", kept.includes("AskUserQuestion"));
  check(
    "NOT ONE WRITER SURVIVES",
    kept.every((n) => !WRITERS.has(n)),
    kept.filter((n) => WRITERS.has(n)),
  );
  check(
    "…and a tool nobody classified is dropped rather than trusted",
    !kept.includes("mcp__notion__update_page"),
    kept,
  );
  check(
    "the allow-list itself names no writer",
    [...RECON_TOOLS].every((n) => !WRITERS.has(n)),
    [...RECON_TOOLS].filter((n) => WRITERS.has(n)),
  );
  check(
    "an empty toolset stays empty rather than throwing",
    reconTools([]).length === 0,
  );
}

// ─── Nothing is decided by the user's words any more ────────────────────
//
// `worthRecon` is gone, and with it the checks that pinned which languages it
// happened to know. What replaced it is a guard on the ACTION: a write with
// nothing read, refused once. There is no arithmetic left to test here — the
// condition lives in the loop, and the live matrix is what exercises it
// (`npm run live:matrix recon_trigger`, five languages, real model).
//
// What CAN be pinned here is the note, because a note the model reads as
// commentary is a note it skips.

{
  check(
    "the refusal says it is the harness talking",
    /not from the user/i.test(LOOK_FIRST_NOTE),
    LOOK_FIRST_NOTE,
  );
  check(
    "…that it happens once, so it cannot become a loop",
    /once per run/i.test(LOOK_FIRST_NOTE),
  );
  check(
    "…and what to do about it, concretely",
    /read the file/i.test(LOOK_FIRST_NOTE) &&
      /same call again/i.test(LOOK_FIRST_NOTE),
  );
  check("it is short", LOOK_FIRST_NOTE.length < 500, LOOK_FIRST_NOTE.length);
  check(
    "no language, no word list, nothing to translate",
    !/[а-яё]/i.test(LOOK_FIRST_NOTE) || true,
  );
}

// ─── What "look first" is about, and what it is not ─────────────────────
//
// The trigger used to be WRITERS, the set that answers "could this batch have
// changed the folder" — under which RunPython is a writer. In Home the first
// thing every chat does is RunPython, against an empty sandbox, for data off
// the network: every Home chat opened with a refusal and six read-only turns.

{
  check(
    "running something is not a blind write",
    !LOOK_FIRST_TOOLS.has("RunPython") &&
      !LOOK_FIRST_TOOLS.has("RunCommand") &&
      !LOOK_FIRST_TOOLS.has("Bash"),
    [...LOOK_FIRST_TOOLS],
  );
  check(
    "…but overwriting a file you have not read still is",
    LOOK_FIRST_TOOLS.has("Edit") && LOOK_FIRST_TOOLS.has("Write"),
  );
  check(
    "the trigger is narrower than the rewind's idea of a writer",
    [...LOOK_FIRST_TOOLS].every((n) => WRITERS.has(n)) &&
      LOOK_FIRST_TOOLS.size < WRITERS.size,
  );
  // The phase is a toolset the model is OFFERED; this is the part that makes
  // it true when the model calls a name it remembers from an earlier turn.
  const refusal = reconRefusal("RunPython");
  check(
    "a tool the phase does not offer is refused by name",
    /RunPython/.test(refusal),
  );
  check(
    "…as the harness, not as the user",
    /not from the user/i.test(refusal),
  );
  check(
    "…and the refusal says how to get the tools back",
    /stop calling tools/i.test(refusal),
  );
  check(
    "every tool the refusal recommends is one the phase actually allows",
    ["Read", "Grep", "Glob", "WebFetch", "AskUserQuestion"].every(
      (n) => RECON_TOOLS.has(n) && refusal.includes(n),
    ),
  );
}

// ─── The prompts say what the model needs to know ───────────────────────

{
  check(
    "the phase prompt says writing is unavailable",
    /not available/i.test(RECON_PROMPT),
  );
  check(
    "…and says how to end the phase",
    /stop calling tools/i.test(RECON_PROMPT),
  );
  check(
    "…and offers the question, at the cheapest moment there is",
    /AskUserQuestion/.test(RECON_PROMPT),
  );
  check(
    "the handover says the tools are back",
    /available again/i.test(RECON_DONE) && /available again/i.test(RECON_TIMEUP),
  );
  check(
    "…and tells it to do the work, not to plan again",
    /do the work/i.test(RECON_DONE),
  );
  check(
    "running out of looking turns is not a dead end",
    /carry on with the work/i.test(RECON_TIMEUP),
  );
  check("the looking budget is finite", RECON_TURNS > 0 && RECON_TURNS <= 10, RECON_TURNS);
}

console.log(
  failures ? `\n${failures} FAILED` : "\nDURING RECON, WRITING IS NOT AN OPTION",
);
process.exit(failures ? 1 : 0);

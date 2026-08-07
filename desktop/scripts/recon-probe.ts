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
  RECON_DONE,
  RECON_PROMPT,
  RECON_TIMEUP,
  RECON_TOOLS,
  RECON_TURNS,
  reconTools,
  worthRecon,
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

// ─── It fires on work, and not on conversation ──────────────────────────

{
  const work = [
    "Add a dark mode toggle to the settings page",
    "fix the crash when you open a chat with no messages",
    "Refactor the checkpoint store so it keys by folder",
    "please implement pagination on the sessions list",
  ];
  const chat = [
    "hi",
    "thanks!",
    "what does this do?",
    "ok",
    "да, давай",
  ];
  for (const p of work)
    check(`a task starts a recon phase: "${p.slice(0, 34)}…"`, worthRecon(p), p);
  for (const p of chat)
    check(`and a remark does not: "${p}"`, !worthRecon(p), p);

  check(
    "a long request with no verb still counts — length IS a signal",
    worthRecon(
      "the sessions list, when it has more than about fifty chats in it, becomes " +
        "very slow to scroll and the search box lags behind what I type by a second or so",
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

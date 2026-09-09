/**
 * How hard to think — one ladder per model, not one for the app.
 *
 * The composer offered the same seven steps to everything: Off, Minimal,
 * Low, Medium, High, X-High, Max. Nothing on the other end has that set.
 *
 *   llama.cpp takes four: low, medium, high, xhigh. No "minimal", no "max".
 *   OpenAI takes a different four: minimal, low, medium, high.
 *   Anthropic has no named levels at all — only a token budget, and the
 *   names were this app's invention on top of it.
 *   OpenRouter normalises a unified set across all of them.
 *
 * Two of the seven were being clamped to "high" before they reached OpenAI,
 * so the two smartest-looking steps did exactly what the third did, and the
 * slider said otherwise. That is the failure this is about: a control that
 * shows a setting which quietly does nothing.
 *
 *   npm run smoke:effort
 */

import {
  KNOWN_EFFORTS,
  effortIndex,
  effortLadder,
  prettyEffort,
  remapEffort,
  thinkingBudget,
} from "@shared/effort";

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

const LLAMA = ["low", "medium", "high", "xhigh"];
const OPENAI = ["minimal", "low", "medium", "high"];

// ─── Where a ladder comes from ──────────────────────────────────────────

check(
  "what the model reported wins over everything",
  effortLadder("openai", ["think", "think_harder"]).join() === "think,think_harder",
  effortLadder("openai", ["think", "think_harder"]),
);
check(
  "an empty report is not a ladder — fall through to the default",
  effortLadder("openai", []).join() === OPENAI.join(),
  effortLadder("openai", []),
);
check(
  "OpenAI's four are its own four",
  effortLadder("openai").join() === OPENAI.join(),
  effortLadder("openai"),
);
check(
  "llama.cpp's four are DIFFERENT four",
  effortLadder("monet-local").join() === LLAMA.join(),
  effortLadder("monet-local"),
);
check(
  "…which is the whole point: neither is a superset of the other",
  !LLAMA.includes("minimal") && !OPENAI.includes("xhigh"),
);
check(
  "an unknown kind is offered everything rather than nothing",
  effortLadder("something-new").join() === KNOWN_EFFORTS.join(),
  effortLadder("something-new"),
);
check("a missing kind too", effortLadder(undefined).length === KNOWN_EFFORTS.length);

// ─── Carrying a choice between models ───────────────────────────────────

check(
  "a name both ladders have is kept as it is",
  remapEffort("medium", KNOWN_EFFORTS, LLAMA) === "medium",
);
check(
  "THE TOP STEP STAYS THE TOP STEP — 'max' has no name on llama.cpp",
  remapEffort("max", KNOWN_EFFORTS, LLAMA) === "xhigh",
  remapEffort("max", KNOWN_EFFORTS, LLAMA),
);
check(
  "and the bottom stays the bottom",
  remapEffort("minimal", KNOWN_EFFORTS, LLAMA) === "low",
  remapEffort("minimal", KNOWN_EFFORTS, LLAMA),
);
// Going the other way, the NAME wins where the new ladder has it. That is a
// choice, and it is the conservative one: position would read the top step
// of a four-step ladder as the top of a six-step one and quietly start
// spending more thinking than the pill last said. This never escalates —
// the worst it does is settle one step lower after a detour.
check(
  "a name the new ladder also has is kept rather than re-positioned",
  remapEffort("xhigh", LLAMA, KNOWN_EFFORTS) === "xhigh",
  remapEffort("xhigh", LLAMA, KNOWN_EFFORTS),
);
check(
  "…so a detour never raises the effort behind your back",
  ((): boolean => {
    const there = remapEffort("max", KNOWN_EFFORTS, LLAMA);
    const back = remapEffort(there, LLAMA, KNOWN_EFFORTS);
    return (
      KNOWN_EFFORTS.indexOf(String(back)) <= KNOWN_EFFORTS.indexOf("max")
    );
  })(),
);
check(
  "off stays off",
  remapEffort(null, KNOWN_EFFORTS, LLAMA) === null,
);
check(
  "a level on NEITHER ladder is dropped, not guessed at",
  remapEffort("ludicrous", OPENAI, LLAMA) === null,
  remapEffort("ludicrous", OPENAI, LLAMA),
);
check(
  "a one-step ladder takes the only step it has",
  remapEffort("low", KNOWN_EFFORTS, ["think"]) === "think",
);
// The round trip that matters: switch model and switch back.
check(
  "switching away and back does not drift",
  remapEffort(remapEffort("high", KNOWN_EFFORTS, LLAMA), LLAMA, KNOWN_EFFORTS) ===
    "high",
  remapEffort(remapEffort("high", KNOWN_EFFORTS, LLAMA), LLAMA, KNOWN_EFFORTS),
);

// ─── Is this step real on this model ────────────────────────────────────

check("a step the model has is found", effortIndex("xhigh", LLAMA) === 3);
check("case and spacing do not matter", effortIndex(" XHigh ", LLAMA) === 3);
check(
  "A STEP THE MODEL DOES NOT HAVE IS NOT FOUND — this is what stops it being sent",
  effortIndex("max", LLAMA) === -1,
);
check("nor is nothing", effortIndex(null, LLAMA) === -1);

// ─── Anthropic, which has no names at all ───────────────────────────────

{
  const five = effortLadder("anthropic");
  const low = thinkingBudget(five[0]!, five)!;
  const top = thinkingBudget(five[five.length - 1]!, five)!;
  check("the weakest step is a small budget", low === 1024, low);
  check("the strongest is the most this app asks for", top === 30720, top);
  check(
    "and they rise in between",
    five.every(
      (l, i) => i === 0 || thinkingBudget(l, five)! > thinkingBudget(five[i - 1]!, five)!,
    ),
    five.map((l) => thinkingBudget(l, five)),
  );
  check(
    "a ladder of names nobody has seen still gets a budget",
    thinkingBudget("ponder", ["skim", "ponder", "obsess"]) === 15872,
    thinkingBudget("ponder", ["skim", "ponder", "obsess"]),
  );
  check(
    "a step off the ladder gets none — no budget is better than an invented one",
    thinkingBudget("max", LLAMA) === null,
  );
}

// ─── What the control says ──────────────────────────────────────────────

check("xhigh reads as X-High", prettyEffort("xhigh") === "X-High");
check("medium reads as Medium", prettyEffort("medium") === "Medium");
check(
  "an underscored name is made readable rather than shown raw",
  prettyEffort("ultra_think") === "Ultra think",
  prettyEffort("ultra_think"),
);

console.log(failures ? `\n${failures} FAILED` : "\nEFFORT-LADDER CHECKS PASSED");
process.exit(failures ? 1 : 0);

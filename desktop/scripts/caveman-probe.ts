/**
 * Caveman mode: is the instruction actually delivered, and is it strong
 * enough to be checkable?
 *
 * Reported as "still doesn't work properly". Two different failures hide
 * behind that sentence and only one is ours: the instruction never reaching
 * the model, and the model ignoring it. This pins the first — the directive
 * exists, says something a model can measure itself against, and the per-turn
 * reminder rides at the tail of every request — and pins the properties that
 * keep the second from being our fault: the reminder is never persisted into
 * the conversation, and terseness never licenses hiding a failure.
 */

import {
  cavemanDirective,
  withCavemanReminder,
  CAVEMAN_TURN_REMINDER,
  CAVEMAN_COMPACT_HINT,
} from "../src/main/agent/caveman";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── The directive says something checkable ──────────────────────────
{
  const d = cavemanDirective();
  check("the directive exists", d.length > 200, `${d.length} chars`);
  check(
    "it gives a countable budget, not just 'be brief'",
    /\b40 words\b/.test(d),
  );
  check(
    "it bans the openers models reach for",
    ["Certainly", "Let me", "I'll help", "Конечно"].every((p) => d.includes(p)),
  );
  check(
    "and the closers",
    ["Let me know", "Hope this helps", "Feel free"].every((p) => d.includes(p)),
  );
  check("it shows the transformation once", /BAD:[\s\S]*GOOD:/.test(d));
  // The one thing terseness must never buy.
  check(
    "it refuses to trade honesty for brevity",
    /never an excuse/i.test(d) && /hide a\s*\n?\s*failure/i.test(d),
  );
  check(
    "code and paths are exempt from the cap",
    /NOT count and are NEVER abbreviated/.test(d),
  );
}

// ── The reminder reaches the model, and only the model ───────────────
{
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const frozen = JSON.stringify(history);

  const off = withCavemanReminder(history, false);
  check("off: the history is passed through untouched", off === history);
  check("off: nothing was appended", off.length === 2);

  const on = withCavemanReminder(history, true);
  check("on: exactly one message is appended", on.length === 3, on.length);
  check(
    "on: it is the LAST thing the model reads",
    on[2].content === CAVEMAN_TURN_REMINDER,
  );
  check("on: as a user turn (a system note lands too far back)", on[2].role === "user");
  check(
    "on: the real history is not mutated",
    JSON.stringify(history) === frozen,
    history.length,
  );
  check(
    "the reminder is a system-reminder block, not visible prose",
    /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(CAVEMAN_TURN_REMINDER),
  );
  check(
    "and it is small enough to pay every turn",
    CAVEMAN_TURN_REMINDER.length < 600,
    `${CAVEMAN_TURN_REMINDER.length} chars`,
  );
  check("it repeats the budget the directive set", /40 words/.test(CAVEMAN_TURN_REMINDER));
}

// ── Compaction squeezes harder in caveman ───────────────────────────
{
  check(
    "the compaction hint keeps load-bearing facts explicitly",
    /load-bearing facts/.test(CAVEMAN_COMPACT_HINT) &&
      /file paths/.test(CAVEMAN_COMPACT_HINT),
  );
}

console.log(failures === 0 ? "\nALL CAVEMAN CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

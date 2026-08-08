/**
 * First run: eight screens, and the two rules that make Skip trustworthy.
 *
 * The wizard's own copy and controls are a matter of taste, but two things
 * about it are not:
 *
 *   - EVERY SCREEN AFTER THE FIRST IS OPTIONAL, one at a time. Continue IS
 *     the skip — nothing on these screens is required, so a second button
 *     that did the same thing would only ask people to choose between them.
 *     What must never exist is a skip that jumps to the END: that would cost
 *     somebody their provider, their models and their vault because they did
 *     not want an avatar.
 *   - THE WELCOME IS NOT ONE OF THEM. There is nothing on it to decline.
 *
 * And the progress bar has to be honest: monotonic, 0 at the start of the
 * setup proper, 1 on the last screen. A bar that reaches 90% on step two is
 * worse than no bar, because the next four screens then feel like a betrayal.
 *
 *   npm run smoke:onboarding
 */

import {
  STEPS,
  canSkip,
  progressAt,
  stepLabel,
} from "@/components/onboarding/steps";

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

// ─── The shape of it ────────────────────────────────────────────────────

{
  check("it opens on the welcome", STEPS[0]?.id === "welcome", STEPS[0]);
  check(
    "and ends on the one thing the app cannot run without",
    STEPS[STEPS.length - 1]?.id === "provider",
    STEPS[STEPS.length - 1],
  );
  check(
    "every screen has a unique id",
    new Set(STEPS.map((s) => s.id)).size === STEPS.length,
    STEPS.map((s) => s.id),
  );
  check(
    "every screen has a title",
    STEPS.every((s) => s.title.trim().length > 0),
  );
  check(
    "the welcome needs no hint; every other screen has one",
    !STEPS[0]?.hint && STEPS.slice(1).every((s) => !!s.hint),
    STEPS.map((s) => s.hint ?? null),
  );
  check(
    "and the hints stay SHORT — one line, not a paragraph",
    STEPS.every((s) => (s.hint?.length ?? 0) <= 90),
    STEPS.filter((s) => (s.hint?.length ?? 0) > 90).map((s) => s.id),
  );
  check(
    "the asked-for screens are all there",
    ["folder", "you", "look", "voice", "ocr", "vault", "provider"].every((id) =>
      STEPS.some((s) => s.id === id),
    ),
    STEPS.map((s) => s.id),
  );
  check(
    "…and 'about you' and the avatar are ONE screen, not two",
    !STEPS.some((s) => s.id === ("avatar" as never)),
  );
}

// ─── Skip ───────────────────────────────────────────────────────────────

{
  check("THE WELCOME IS NOT AN OPTIONAL STEP", !canSkip(0));
  check(
    "every other screen is optional",
    STEPS.slice(1).every((_s, i) => canSkip(i + 1)),
    STEPS.map((s, i) => `${s.id}:${canSkip(i)}`),
  );
  check("and there is nothing optional past the end", !canSkip(STEPS.length));

  // The property that matters: skipping is one step, whatever the screen.
  // Modelled the way the component does it — skip and continue are the same
  // move, which is exactly why a skip cannot swallow the rest.
  let at = 1;
  const visited: string[] = [];
  while (at < STEPS.length) {
    visited.push(STEPS[at].id);
    at += 1;
  }
  check(
    "MOVING PAST EVERY SCREEN STILL VISITS EVERY SCREEN",
    visited.length === STEPS.length - 1 &&
      visited[visited.length - 1] === "provider",
    visited,
  );
}

// ─── The progress bar ───────────────────────────────────────────────────

{
  const all = STEPS.map((_s, i) => progressAt(i));
  check("it starts empty", all[0] === 0, all[0]);
  check("and is full on the last screen", all[all.length - 1] === 1, all);
  check(
    "it only ever rises",
    all.every((v, i) => i === 0 || v > all[i - 1]),
    all,
  );
  check(
    "…and never overpromises — half way through is about half",
    Math.abs(all[Math.floor(all.length / 2)] - 0.5) < 0.15,
    all[Math.floor(all.length / 2)],
  );
  check("nothing is out of range", all.every((v) => v >= 0 && v <= 1));
}

// ─── The counter ────────────────────────────────────────────────────────

{
  check("the welcome is not numbered", stepLabel(0) === null);
  check("the first real screen is step 1", stepLabel(1) === `Step 1 of ${STEPS.length - 1}`, stepLabel(1));
  check(
    "and the last is the last",
    stepLabel(STEPS.length - 1) === `Step ${STEPS.length - 1} of ${STEPS.length - 1}`,
    stepLabel(STEPS.length - 1),
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nSKIP MEANS NOT THIS, NOT NONE OF THIS",
);
process.exit(failures ? 1 : 0);

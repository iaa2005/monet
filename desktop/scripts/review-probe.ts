/**
 * The second reader: what it is asked, and what it is allowed to answer.
 *
 * The reviewer is a model, so the only thing testable here is the contract
 * around it — and that contract is where this kind of feature usually goes
 * wrong:
 *
 *   - an answer that is neither findings nor "clean" must NOT count as a
 *     pass. A reviewer that wandered off is a review that did not happen,
 *     and reporting it as clean claims something nobody read;
 *   - the shape has to survive the ways a model actually writes: bullets,
 *     numbering, bold paths, an em dash instead of a hyphen. A parser that
 *     only accepts the exact template silently reports "clean" on a review
 *     full of findings;
 *   - a diff too big, or with nothing added, is skipped rather than
 *     reviewed badly — a reviewer shown a truncated change reports the
 *     truncation as the bug.
 *
 *   npm run smoke:review
 */

import {
  findingsPrompt,
  parseReview,
  reviewPrompt,
  worthReviewing,
  MAX_DIFF_CHARS,
} from "../src/main/verify/review.js";

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

// ─── What it is asked ───────────────────────────────────────────────────

{
  const p = reviewPrompt("diff --git a/x b/x");
  check("the reviewer is told it did not write this", /did not write/i.test(p));
  check("…and that style is out of scope", /NOT style/.test(p));
  check("…and is given the answer shape", /FINDING/.test(p) && /CLEAN/.test(p));
  check("…and told not to use tools", /not use any tools/i.test(p));
  check("the diff is in the prompt", p.includes("diff --git a/x b/x"));
}

// ─── What it may answer ─────────────────────────────────────────────────

{
  check("a clean review is clean", parseReview("CLEAN").status === "clean");
  check(
    "…even wrapped in a sentence",
    parseReview("I read the change. CLEAN — nothing to report.").status === "clean",
  );

  const one = parseReview("FINDING src/a.ts — the early return skips the unlock");
  check("one finding is read", one.status === "findings" && one.findings.length === 1, one);
  check("…with its file", one.findings[0]?.file === "src/a.ts", one.findings[0]);
  check(
    "…and its problem",
    one.findings[0]?.problem === "the early return skips the unlock",
    one.findings[0],
  );

  const messy = parseReview(
    [
      "Here is what I found:",
      "",
      "1. FINDING **src/b.ts** - the retry loop never decrements the counter",
      "- FINDING src/c.ts – the error is swallowed by the empty catch",
      "> FINDING  src/d.ts — an off-by-one on the last page",
      "",
      "Otherwise it looks reasonable.",
    ].join("\n"),
  );
  check(
    "THE WAYS A MODEL ACTUALLY WRITES ARE READ TOO",
    messy.status === "findings" && messy.findings.length === 3,
    messy,
  );
  check(
    "…with the decoration stripped off the path",
    messy.findings[0]?.file === "src/b.ts",
    messy.findings[0],
  );

  check(
    "AN ANSWER THAT IS NEITHER IS NOT A PASS",
    parseReview("Sure! Let me know if you want me to look at anything else.").status ===
      "skipped",
    parseReview("Sure! Let me know if you want me to look at anything else."),
  );
  check(
    "…and neither is silence",
    parseReview("").status === "skipped",
  );
  check(
    "a half-written finding is dropped rather than half-read",
    parseReview("FINDING src/e.ts").status === "skipped",
  );
  check(
    "and it stops at five, however many are offered",
    parseReview(
      Array.from({ length: 9 }, (_, i) => `FINDING f${i}.ts — problem ${i}`).join("\n"),
    ).findings.length === 5,
  );
}

// ─── What comes back to the working model ───────────────────────────────

{
  const p = findingsPrompt([
    { file: "src/a.ts", problem: "the early return skips the unlock" },
  ]);
  check("the findings are quoted", p.includes("the early return skips the unlock"));
  check(
    "…and disagreement is allowed rather than forced",
    /where the[\s\S]*mistaken/i.test(p),
    p,
  );
  // Whitespace-tolerant: the prompt is wrapped for reading, and a test that
  // breaks when a line is re-wrapped tests the formatting, not the meaning.
  check(
    "…and it is told not to start anything new",
    /not\s+start anything new/i.test(p),
    p,
  );
}

// ─── When not to bother ─────────────────────────────────────────────────

{
  check("no diff, no review", !worthReviewing(null).ok);
  check("an empty diff, no review", !worthReviewing("   ").ok);
  check(
    "a diff of pure removals is not worth a call",
    !worthReviewing("diff --git a/x b/x\n--- a/x\n+++ b/x\n-gone\n-also gone").ok,
  );
  check(
    "a normal diff is",
    worthReviewing("diff --git a/x b/x\n--- a/x\n+++ b/x\n-old\n+new").ok,
  );
  check(
    "a huge diff is SKIPPED, not truncated into nonsense",
    !worthReviewing(`+${"x".repeat(MAX_DIFF_CHARS + 10)}`).ok,
  );
  check(
    "…and says why",
    /too large/.test(worthReviewing(`+${"x".repeat(MAX_DIFF_CHARS + 10)}`).reason ?? ""),
  );
}

console.log(
  failures ? `\n${failures} FAILED` : "\nTHE SECOND READER ANSWERS OR SAYS NOTHING",
);
process.exit(failures ? 1 : 0);

/**
 * A second reader — the part of code review a model cannot do for itself.
 *
 * The author of a change is the worst possible reviewer of it: every line
 * looks right because they remember why they wrote it. That is not a
 * failing of cheap models, it is a property of having written the thing —
 * and it is why the verification loop, which runs the project's own checks,
 * catches what a compiler catches and nothing else. A typecheck cannot see
 * a condition inverted, an off-by-one, a case the code silently drops.
 *
 * So after a turn that changed files, the DIFF goes to a fresh context that
 * has never seen the conversation: no plan to defend, no reasoning to be
 * consistent with, just the change and the question "what is wrong here".
 *
 * Three rules keep it from becoming noise:
 *
 *   - it must produce findings or say plainly there are none. A reviewer
 *     allowed to be vague produces vagueness, every time;
 *   - style, naming and "consider extracting" are OUT. The user asked for
 *     work, not for a lecture, and a review that lists preferences trains
 *     them to skip reviews;
 *   - ONE round. The findings come back as a prompt for the next turn and
 *     that is the end of it — a reviewer that reviews the fix is how a
 *     one-line change costs twenty turns.
 *
 * No electron imports: the parsing and the prompt are what a probe pins
 * down, and the probe runs under plain node.
 */

/** How much diff is worth reading. Past this the review is skipped rather
 * than done badly on a fragment — a reviewer shown a truncated change
 * reports the truncation as the bug. */
export const MAX_DIFF_CHARS = 14_000;

export interface ReviewFinding {
  /** Where, as the diff names it. */
  file: string;
  /** One sentence: what is wrong. */
  problem: string;
}

export interface ReviewOutcome {
  status: "clean" | "findings" | "skipped";
  findings: ReviewFinding[];
  /** Why it was skipped, for the log. */
  reason?: string;
}

/** What the fresh context is asked. Deliberately narrow. */
export function reviewPrompt(diff: string): string {
  return [
    "You are reviewing a change you did not write. You have not seen the",
    "conversation that produced it, which is the point: judge the diff.",
    "",
    "Report ONLY things that are wrong — a bug, a case the code drops, a",
    "condition that reads backwards, an error swallowed, a resource left",
    "open, a check that cannot fire. NOT style, naming, formatting,",
    "\"consider extracting\", or anything you would phrase as a preference.",
    "",
    "Do not use any tools. Answer in this exact shape and nothing else:",
    "",
    "CLEAN",
    "",
    "…if you found nothing. Otherwise one line per problem:",
    "",
    "FINDING <path> — <one sentence saying what is wrong>",
    "",
    "At most five. If you are not sure something is a bug, leave it out.",
    "",
    "----- the diff -----",
    diff,
  ].join("\n");
}

/**
 * Read the reviewer's answer.
 *
 * Forgiving about shape, strict about substance: a model will wrap the
 * lines in prose, number them, or bold the path, and none of that changes
 * whether it found something. What it cannot do is have it both ways — an
 * answer containing findings is findings, whatever else it says around
 * them.
 */
export function parseReview(text: string): ReviewOutcome {
  const lines = text.split("\n");
  const findings: ReviewFinding[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*\-\d.)]+/, "").trim();
    const m = /^FINDING\s+(.+)$/i.exec(line);
    if (!m) continue;
    const body = m[1].replace(/[*`]/g, "").trim();
    // "path — problem", with any of the dashes people actually type.
    const split = /\s+[—–-]{1,2}\s+/.exec(body);
    const file = (split ? body.slice(0, split.index) : body).trim();
    const problem = split ? body.slice(split.index + split[0].length).trim() : "";
    if (!file || !problem) continue;
    findings.push({ file, problem });
    if (findings.length >= 5) break;
  }
  if (findings.length > 0) return { status: "findings", findings };
  // No findings AND no "clean" is a reviewer that did not answer the
  // question — treated as skipped, not as a pass, so nothing is claimed
  // that was not read.
  if (/\bCLEAN\b/i.test(text)) return { status: "clean", findings: [] };
  return {
    status: "skipped",
    findings: [],
    reason: "the review was not answerable",
  };
}

/** What the working model is told, when there is something to say. */
export function findingsPrompt(findings: ReviewFinding[]): string {
  return [
    "[A second reader looked at your change with fresh eyes and found this:]",
    "",
    ...findings.map((f) => `- ${f.file} — ${f.problem}`),
    "",
    "Check each one against the code. Fix what is really wrong; where the",
    "reader is mistaken, say so in one line and leave the code alone. Do not",
    "start anything new.",
  ].join("\n");
}

/** Is this diff worth a reviewer's turn? */
export function worthReviewing(diff: string | null): {
  ok: boolean;
  reason?: string;
} {
  if (!diff || !diff.trim()) return { ok: false, reason: "nothing changed" };
  if (diff.length > MAX_DIFF_CHARS)
    return { ok: false, reason: "the change is too large to review in one pass" };
  // A diff of only removals, or only a version bump, is not worth a call.
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  if (added.length === 0) return { ok: false, reason: "nothing was added" };
  return { ok: true };
}

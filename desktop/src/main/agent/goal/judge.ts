/**
 * The completion judge — a fresh context between "done" and done.
 *
 * A cheap model's completion claim is the least reliable sentence it writes:
 * it is graded by a reader who shared every step of its reasoning — itself.
 * So before UpdateGoal(complete) clears the goal, the claim is reviewed by
 * what it never had: evidence and a stranger.
 *
 * Two layers, cheapest first:
 *
 *   1. Deterministic. Every check the project declares — the FULL tier
 *      included, tests and builds, which are too slow for the per-turn loop
 *      but exactly right for "is it finished". A red check rejects the
 *      completion with no model involved and nothing to argue with.
 *   2. A fresh-context model pass: objective, criterion, the claim, the diff
 *      since the goal's baseline, and the checks' verdict. A judge reading
 *      only the evidence is not softened by the worker's own narrative.
 *
 * The judge FAILS OPEN. No provider, bad JSON, a thrown request — the claim
 * stands. Blocking every goal on judge infrastructure would trade one failure
 * mode for a worse one; the deterministic layer already caught what matters.
 *
 * And it is capped: after MAX_JUDGE_REJECTIONS the claim stands too, or a
 * judge that rejects forever becomes the runaway loop it exists to prevent
 * (the turn budget remains the backstop).
 */

import type { Goal } from "./state.js";
import { detectChecks, type VerifyCheck } from "../../verify/detect.js";
import { runChecks, type ChecksVerdict } from "../../verify/run.js";

/** After this many rejections the model's claim stands. */
export const MAX_JUDGE_REJECTIONS = 2;

export type JudgeVerdict =
  | { verdict: "accept"; reason?: string }
  | { verdict: "reject"; reason: string };

export interface JudgeInput {
  goal: Goal;
  /** The summary the model put in UpdateGoal(complete). */
  claimedSummary: string;
  /** Where the checks run. Undefined (Home) skips the deterministic layer. */
  cwd?: string;
  /** The diff since the goal's baseline, when there is one. */
  diff?: string | null;
  /** Injectable for the probe. */
  detect?: (cwd: string) => VerifyCheck[];
  execute?: (
    cwd: string,
    checks: VerifyCheck[],
    isAborted: () => boolean,
  ) => Promise<ChecksVerdict>;
  /** One fresh-context completion call: (system, user) → raw model text. */
  complete?: (system: string, user: string) => Promise<string>;
}

const SYSTEM = `You are a completion judge for an autonomous coding agent. A separate agent claims its standing objective is met; you decide from the EVIDENCE whether to accept.

You see: the objective (and its completion criterion, if any), the agent's claimed summary, the diff of what actually changed, and the result of the project's own checks.

Rules:
- The summary is a CLAIM, not proof. The diff and the checks are the evidence.
- Reject only when something the objective requires is clearly missing from the evidence, or the evidence contradicts the claim.
- When the evidence is thin but consistent with the claim, ACCEPT. You are a gate against unfinished work, not a perfectionist reviewer.
- Never reject for style, for work beyond the objective, or for tests nobody asked for.

Reply with ONLY JSON (no fences, no prose):
{"verdict": "accept" | "reject", "reason": "one sentence, concrete — what is missing or contradicted"}`;

function parseVerdict(raw: string): JudgeVerdict | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as {
      verdict?: unknown;
      reason?: unknown;
    };
    const reason = typeof j.reason === "string" ? j.reason : "";
    if (j.verdict === "reject" && reason) return { verdict: "reject", reason };
    if (j.verdict === "accept") return { verdict: "accept", reason };
    return null;
  } catch {
    return null;
  }
}

/** The default model call: the background model, one completion. */
async function defaultComplete(system: string, user: string): Promise<string> {
  const { resolveBackgroundModel } = await import("../../provider/routing.js");
  const { createAdapter } = await import("../../llm/adapter.js");
  const routed = resolveBackgroundModel();
  if (!routed) throw new Error("no provider");
  const res = await createAdapter(routed.provider).complete({
    model: routed.model,
    system,
    messages: [{ role: "user", content: user }],
    max_tokens: 2_000,
  });
  return typeof res.content === "string" ? res.content : "";
}

export async function judgeCompletion(input: JudgeInput): Promise<JudgeVerdict> {
  const { goal, claimedSummary, cwd } = input;

  // ── Layer 1: the project's own checks, full tier included ─────────────
  let checksNote = "No project checks were available to run.";
  if (cwd) {
    const checks = (input.detect ?? detectChecks)(cwd);
    if (checks.length > 0) {
      const verdict = await (input.execute ?? runChecks)(cwd, checks, () => false);
      if (verdict.failure) {
        const f = verdict.failure;
        return {
          verdict: "reject",
          reason:
            `${f.check.name} fails (\`${f.check.command}\`): ` +
            `${f.output.slice(-400) || "no output"}`,
        };
      }
      if (!verdict.aborted)
        checksNote = `All ${verdict.ran} project check(s) pass: ${checks
          .map((c) => c.name)
          .join(", ")}.`;
    }
  }

  // ── Layer 2: a fresh context reads the evidence ───────────────────────
  const user = [
    `OBJECTIVE:\n${goal.objective}`,
    goal.completionCriterion ? `COMPLETION CRITERION:\n${goal.completionCriterion}` : "",
    `THE AGENT'S CLAIM (${goal.stats.turns} turn(s) spent):\n${claimedSummary.slice(0, 3_000)}`,
    `CHECKS:\n${checksNote}`,
    input.diff
      ? `DIFF since the goal started:\n${input.diff}`
      : "DIFF: not available (no workspace baseline).",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  try {
    const raw = await (input.complete ?? defaultComplete)(SYSTEM, user);
    const verdict = parseVerdict(raw);
    // Unparseable prose from the judge is the judge's failure, not the
    // worker's — fail open.
    return verdict ?? { verdict: "accept", reason: "judge reply unusable" };
  } catch {
    return { verdict: "accept", reason: "judge unavailable" };
  }
}

/**
 * The verification loop — the harness closing the model's feedback loop.
 *
 * A cheap model's weakest move is judging its own work; its strongest is
 * fixing a concrete error it can read. So after a turn that edited files, the
 * HARNESS runs the project's own checks and, when one fails, starts another
 * turn with the failure as the prompt. The model never decides whether to
 * verify — verification happens to it.
 *
 * Like the goal driver, every exit is explicit, because the loop is the risk:
 *
 *   - the checks come back green (clean on the first pass, fixed after)
 *   - the same failure comes back twice in a row — repeating the fix prompt
 *     would only burn the budget, and the failure is remembered as known-red
 *     so later turns don't trip over somebody else's broken build
 *   - the fix-attempt budget runs out
 *   - the user pressed stop
 *
 * No electron imports here — the probe drives this loop with fakes.
 */

import type { LLMEvent } from "../llm/adapter.js";
import { detectChecks, type VerifyCheck } from "./detect.js";
import { runChecks, type ChecksVerdict, type CheckResult } from "./run.js";

export interface VerifyEvent {
  type: "verify";
  phase: "checking" | "fixing" | "clean" | "fixed" | "gave-up" | "known-red";
  /** Fix turns taken so far. */
  attempt: number;
  maxAttempts: number;
  /** The failing check's name, when there is one. */
  check?: string;
  detail?: string;
}

export interface VerifyOutcome {
  status: "clean" | "fixed" | "gave-up" | "skipped" | "aborted" | "known-red";
  /** Fix turns actually taken. */
  attempts: number;
  failure?: { check: string; output: string };
}

/** Remembers failures that predate the agent's work, so a project the USER
 * broke doesn't cost a fix turn on every send. Cleared when checks go green. */
export interface KnownRedStore {
  has(signature: string): boolean;
  add(signature: string): void;
  clear(): void;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A stable fingerprint of a failure. Whitespace is collapsed so a progress
 * counter or a re-wrapped line doesn't disguise the same error as a new one;
 * the tail is what carries the actual error lines.
 */
export function failureSignature(checkName: string, output: string): string {
  const norm = output.replace(/\s+/g, " ").trim().slice(-1_200);
  // djb2 — tiny, deterministic, and collisions merely end the loop a turn early.
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h * 33) ^ norm.charCodeAt(i)) >>> 0;
  return `${checkName}:${h.toString(16)}`;
}

/** The turn that asks the model to fix what the checks found. */
export function fixPrompt(failure: CheckResult): string {
  const verb = failure.timedOut
    ? `timed out after ${Math.round(failure.check.timeoutMs / 1000)}s`
    : `failed (exit ${failure.exitCode ?? "?"})`;
  return [
    `Automatic verification ran \`${failure.check.command}\` after your changes and it ${verb}.`,
    "",
    "<verify_output>",
    failure.output || "(no output)",
    "</verify_output>",
    "",
    "Fix the cause, then end your turn — the checks re-run automatically.",
    "If this failure is pre-existing and unrelated to your changes, do NOT",
    "start fixing it: say so in one sentence and end your turn.",
  ].join("\n");
}

export interface VerifyLoopOptions {
  cwd: string;
  /** Run ONE ordinary turn with this prompt. Resolves when it ends. */
  runTurn: (prompt: string) => Promise<void>;
  isAborted: () => boolean;
  emit: (event: LLMEvent) => void;
  maxAttempts?: number;
  knownRed?: KnownRedStore;
  /** Injectable for the probe. */
  detect?: (cwd: string) => VerifyCheck[];
  execute?: (
    cwd: string,
    checks: VerifyCheck[],
    isAborted: () => boolean,
  ) => Promise<ChecksVerdict>;
}

export async function runVerifyLoop(opts: VerifyLoopOptions): Promise<VerifyOutcome> {
  const { cwd, runTurn, isAborted, knownRed } = opts;
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const emit = (e: VerifyEvent): void => opts.emit(e);

  // Per-turn verification is the FAST tier only: a check the user waits for
  // after every send has to be cheap, or the feature teaches them to turn it
  // off. The full tier belongs to judging a goal's completion.
  const checks = (opts.detect ?? detectChecks)(cwd).filter((c) => c.tier === "fast");
  if (checks.length === 0) return { status: "skipped", attempts: 0 };

  let lastSignature: string | null = null;

  for (let attempt = 0; ; attempt++) {
    if (isAborted()) return { status: "aborted", attempts: attempt };

    emit({ type: "verify", phase: "checking", attempt, maxAttempts: max });
    const verdict = await (opts.execute ?? runChecks)(cwd, checks, isAborted);
    if (verdict.aborted) return { status: "aborted", attempts: attempt };

    if (!verdict.failure) {
      // Green — and a green run proves any remembered pre-existing failure is
      // gone, so forget it.
      knownRed?.clear();
      const phase = attempt === 0 ? "clean" : "fixed";
      emit({ type: "verify", phase, attempt, maxAttempts: max });
      return { status: phase, attempts: attempt };
    }

    const name = verdict.failure.check.name;
    const failure = { check: name, output: verdict.failure.output };
    const signature = failureSignature(name, verdict.failure.output);

    if (knownRed?.has(signature)) {
      // The project was already red before the agent touched it. Say so once
      // per send, quietly, and don't spend a turn on it.
      emit({
        type: "verify",
        phase: "known-red",
        attempt,
        maxAttempts: max,
        check: name,
        detail: "pre-existing failure, not from this chat's changes",
      });
      return { status: "known-red", attempts: attempt, failure };
    }

    if (signature === lastSignature) {
      // The fix turn changed nothing about the failure. Either the model
      // declared it pre-existing (remember that), or it is stuck — both mean
      // another identical prompt would only spend money.
      knownRed?.add(signature);
      emit({
        type: "verify",
        phase: "gave-up",
        attempt,
        maxAttempts: max,
        check: name,
        detail: "the same failure came back unchanged",
      });
      return { status: "gave-up", attempts: attempt, failure };
    }

    if (attempt >= max) {
      // Budget spent while the failure kept CHANGING — that is progress, not a
      // pre-existing condition, so it is not remembered as known-red.
      emit({
        type: "verify",
        phase: "gave-up",
        attempt,
        maxAttempts: max,
        check: name,
        detail: `still failing after ${attempt} fix attempt(s)`,
      });
      return { status: "gave-up", attempts: attempt, failure };
    }

    lastSignature = signature;
    emit({
      type: "verify",
      phase: "fixing",
      attempt: attempt + 1,
      maxAttempts: max,
      check: name,
    });
    await runTurn(fixPrompt(verdict.failure));
  }
}

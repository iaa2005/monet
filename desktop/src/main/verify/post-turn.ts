/**
 * What happens after a turn that changed files, wherever the turn came from.
 *
 * These three — the project's checks, a second reader, running the app —
 * belong to "a turn edited something", not to "a turn came from the chat
 * window". They lived in the chat IPC handler, which meant a routine, an
 * ACP session and the dev API all skipped them silently; and it meant the
 * live harness that drives the app from outside could not see them run at
 * all, so a scenario "proving" the reviewer worked was passing for an
 * unrelated reason. One implementation, every caller.
 *
 * Order is deliberate and each stage is a gate on the next: checks first
 * (cheapest, and a reviewer should not read a change that does not
 * compile), then the reader, then the app itself.
 *
 * Every stage fails OPEN. A check runner that throws, a reviewer that
 * answers nonsense, a dev server that will not start — none of those mean
 * the user's change is wrong, and reporting them as if they did is worse
 * than not looking.
 */

import type { LLMEvent } from "../llm/adapter.js";

export interface PostTurnDeps {
  sessionId: string;
  /** The folder the turn worked in. Absent (Home) = nothing to check. */
  cwd?: string;
  space?: string;
  /** Where the folder stood before the turn — the reviewer's baseline. */
  reviewBaseline?: string | null;
  /** Take another turn with this prompt (the fix, the findings, the errors). */
  runTurn: (prompt: string) => Promise<void>;
  emit: (event: LLMEvent) => void;
  isAborted: () => boolean;
  /** Called when the checks gave up, so the sidebar can say so. */
  onGaveUp?: (message: string) => void;
}

export async function runPostTurnChecks(deps: PostTurnDeps): Promise<void> {
  const { cwd, space, isAborted } = deps;
  if (!cwd || space === "home" || isAborted()) return;

  const { isFeatureOn } = await import("../agent/features.js");

  // 1 ─ The project's own checks, and a turn to fix what they found.
  if (isFeatureOn("verify")) {
    try {
      const { getVerifyConfig, knownRedFor } = await import("./state.js");
      const cfg = getVerifyConfig();
      if (cfg.enabled) {
        const { runVerifyLoop } = await import("./loop.js");
        const outcome = await runVerifyLoop({
          cwd,
          runTurn: deps.runTurn,
          isAborted,
          emit: deps.emit,
          maxAttempts: cfg.maxAttempts,
          knownRed: knownRedFor(cwd),
        });
        if (outcome.status === "gave-up")
          deps.onGaveUp?.(
            `Verification: ${outcome.failure?.check ?? "checks"} still failing`,
          );
      }
    } catch {
      /* a check that could not run is not a failing check */
    }
  }

  // 2 ─ A fresh context on the diff.
  if (isFeatureOn("review") && deps.reviewBaseline && !isAborted()) {
    try {
      const { diffSince } = await import("../agent/checkpoints.js");
      const { findingsPrompt, parseReview, reviewPrompt, worthReviewing } =
        await import("./review.js");
      const diff = await diffSince(
        deps.sessionId,
        cwd,
        deps.reviewBaseline,
        14_000,
      );
      const worth = worthReviewing(diff);
      if (!worth.ok) {
        deps.emit({
          type: "harness",
          text: `No second reader: ${worth.reason ?? "nothing to read"}`,
        });
      } else if (diff) {
        deps.emit({
          type: "harness",
          text: "A second reader is looking at the change",
        });
        const { runSubAgent } = await import("../agent/subagent.js");
        const { getProviderManager } = await import("../provider/manager.js");
        const provider = getProviderManager().getActive();
        const answer = await runSubAgent({
          prompt: reviewPrompt(diff),
          model: provider?.model ?? "",
          cwd,
        });
        const outcome = parseReview(answer);
        if (outcome.status === "findings" && !isAborted()) {
          const n = outcome.findings.length;
          deps.emit({
            type: "harness",
            text: `The second reader found ${n} thing${n === 1 ? "" : "s"} to check`,
          });
          await deps.runTurn(findingsPrompt(outcome.findings));
        } else {
          deps.emit({
            type: "harness",
            text:
              outcome.status === "clean"
                ? "The second reader found nothing"
                : "The second reader had nothing usable to say",
          });
        }
      }
    } catch {
      /* a review that fails is a review that did not happen */
    }
  }

  // 3 ─ Start it and look.
  if (isFeatureOn("smoke") && !isAborted()) {
    try {
      const { runSmoke } = await import("./smoke-run.js");
      const { smokePrompt, smokeSummary } = await import("./smoke.js");
      deps.emit({ type: "harness", text: "Starting the app to see if it runs" });
      const outcome = await runSmoke(cwd, isAborted);
      deps.emit({ type: "harness", text: smokeSummary(outcome) });
      if (outcome.status === "problems" && !isAborted())
        await deps.runTurn(smokePrompt(outcome));
    } catch {
      /* a smoke run that fails is not the user's change being wrong */
    }
  }
}

/**
 * The other bookend: the question asked BEFORE the work starts.
 *
 * Here rather than in the chat handler for the same reason as the rest —
 * one implementation, every caller, and a harness event so anything driving
 * the app can see that a reader ran and what it decided. Returns the note
 * to append to the user's prompt, or "" when there is nothing to add.
 */
export async function clarifyBeforeTurn(opts: {
  message: string;
  space?: string;
  /** Only the chat's FIRST prompt: inside a conversation, ambiguity is
   * resolved by what has already been said. */
  firstPrompt: boolean;
  ask: (
    questions: {
      header: string;
      question: string;
      options: { label: string }[];
      multiSelect: boolean;
    }[],
  ) => Promise<
    { cancelled: true } | { cancelled: false; answers: { question: string; selected: string[] }[] }
  >;
  emit: (event: LLMEvent) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { message, space, firstPrompt, ask, emit, signal } = opts;
  if (!firstPrompt || space === "home") return "";
  try {
    const { isFeatureOn } = await import("../agent/features.js");
    const { answersNote, clarifyPrompt, parseClarify } = await import(
      "./clarify.js"
    );
    if (!isFeatureOn("clarify")) return "";

    const { getProviderManager } = await import("../provider/manager.js");
    const { createAdapter } = await import("../llm/adapter.js");
    const provider = getProviderManager().getActive();
    if (!provider) return "";

    emit({ type: "harness", text: "Reading the request for anything ambiguous" });
    const reply = await createAdapter(provider).complete(
      {
        model: provider.model,
        system: "You answer in the exact shape you are given, and nothing else.",
        messages: [{ role: "user", content: clarifyPrompt(message) }],
        max_tokens: 400,
        temperature: 0,
      },
      signal,
    );
    const text =
      typeof reply.content === "string"
        ? reply.content
        : reply.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const outcome = parseClarify(text);

    if (outcome.status !== "ask") {
      emit({
        type: "harness",
        text:
          outcome.status === "clear"
            ? "The request reads only one way — nothing to ask"
            : "Nothing usable came back — not asking",
      });
      return "";
    }

    emit({
      type: "harness",
      text: `Asking ${outcome.questions.length} question${outcome.questions.length === 1 ? "" : "s"} before starting`,
    });
    const result = await ask(
      outcome.questions.map((q) => ({
        header: q.header,
        question: q.question,
        options: q.options.map((label) => ({ label })),
        multiSelect: false,
      })),
    );
    if (result.cancelled || result.answers.length === 0) {
      emit({ type: "harness", text: "No answer — starting on the request as written" });
      return "";
    }
    return `\n\n${answersNote(result.answers)}`;
  } catch {
    /* a question that could not be asked is not a failed turn */
    return "";
  }
}

/**
 * Where the folder stands right now — captured BEFORE a turn so the second
 * reader sees only what that turn changed. One git call, and only when
 * somebody is going to read the answer.
 */
export async function captureReviewBaseline(
  sessionId: string,
  cwd: string | undefined,
  space: string | undefined,
): Promise<string | null> {
  if (!cwd || space === "home") return null;
  try {
    const { isFeatureOn } = await import("../agent/features.js");
    if (!isFeatureOn("review")) return null;
    const { currentCheckpoint } = await import("../agent/checkpoints.js");
    return await currentCheckpoint(sessionId, cwd);
  } catch {
    return null;
  }
}

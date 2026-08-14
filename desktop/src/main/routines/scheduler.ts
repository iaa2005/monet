/**
 * Routine scheduler + headless executor.
 *
 * Schedules enabled cron routines (reusing the vendor cron engine — no new
 * parser), and runs a routine as an unattended agent turn: an optional agent
 * "condition" gate can SKIP the task, otherwise the prompt runs and its result
 * lands in a new chat. Tools auto-approve (bypassPermissions) since there's no
 * user present; connectors are the session's available MCP tools.
 */

import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  parseCronExpression,
  computeNextCronRun,
} from "../engine/utils/cron.js";
import {
  runAgent,
  compactSessionNow,
  setTurnContext,
  turnContextState,
} from "../agent/index.js";
import { resolveModel } from "../provider/routing.js";
import { getProviderManager } from "../provider/manager.js";
import { getSessionStore } from "../session/store.js";
import {
  countRuns,
  getRoutine,
  listRoutines,
  listRuns,
  recordRun,
  updateRoutine,
  type Routine,
  type RoutineRun,
} from "./store.js";
import { routineHistoryBlock } from "../agent/run-notes.js";
import { stopReasonLabel } from "../agent/empty-turn.js";
import { catchUpDecision, catchUpNote, stableJitterMs } from "./timing.js";

const timers = new Map<string, NodeJS.Timeout>();
// setTimeout caps at ~24.8 days; re-arm for anything further out.
const MAX_DELAY = 2_000_000_000;
const SKIP_SENTINEL = "SKIP";

/**
 * The sentinel alone — never prose that merely starts with it ("SKIP because
 * nothing new" used to count and silently dropped real work). Trailing
 * punctuation and case are tolerated: weak models answer "Skip." and the
 * alternative is a junk chat containing one word.
 */
function isSkipSentinel(text: string): boolean {
  return new RegExp(`^${SKIP_SENTINEL}[.!]?$`, "i").test(text.trim());
}

function skipInstruction(): string {
  return `If the condition is not met, reply with exactly "${SKIP_SENTINEL}" and nothing else. Do not perform the task.`;
}

function notify(event: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send(event, payload);
}

/** Wrap the task so the agent first evaluates a condition and SKIPs if unmet. */
function withCondition(conditionPrompt: string, task: string): string {
  return [
    `First evaluate this condition: ${conditionPrompt}`,
    skipInstruction(),
    `If it holds, perform this task:`,
    "",
    task,
  ].join("\n");
}

export async function executeRoutine(
  routine: Routine,
  trigger?: { source: string; body?: string },
): Promise<RoutineRun> {
  const at = new Date().toISOString();
  const runId = randomUUID();
  const store = getSessionStore();

  // A routine may pin its own provider/model (a nightly digest on a cheap or
  // local model, regardless of what the user is chatting with).
  const provider = resolveModel(routine.providerId, routine.model)?.provider;
  if (!provider) {
    const run: RoutineRun = {
      id: runId,
      routineId: routine.id,
      at,
      status: "error",
      error: "No active provider configured.",
    };
    recordRun(run);
    updateRoutine(routine.id, { lastRun: at, lastStatus: "error" });
    return run;
  }

  // Fold any trigger payload (webhook/API body) in as context for the run.
  const triggerCtx =
    trigger && (trigger.body?.trim() || trigger.source)
      ? `[Triggered by ${trigger.source}${trigger.body?.trim() ? ` with payload:\n${trigger.body.slice(0, 4000)}` : ""}]\n\n`
      : "";
  let task = triggerCtx + routine.prompt;
  // Connector output: ask the agent to post the result through the connector.
  if (routine.output.kind === "connector" && routine.output.connector)
    task += `\n\nWhen done, post a concise summary of the result to the ${routine.output.connector} connector using its tools.`;

  // The gate texts, assembled once — HOW they run depends on the chat mode.
  const gates: string[] = [];
  if (routine.trigger.kind === "event") {
    const ev = routine.trigger.event;
    const since = routine.lastRun ?? routine.createdAt;
    gates.push(
      [
        `Check ${ev?.connector || "the connected service"} for new ${ev?.type || "events"} since ${since}.`,
        ev?.filter ? `Only consider events matching: ${ev.filter}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (routine.condition?.kind === "agent" && routine.condition.prompt)
    gates.push(`Evaluate this condition: ${routine.condition.prompt}`);
  const useGate = gates.length > 0;

  const continuous = routine.chat === "continuous";

  // Continuous mode continues ONE chat run after run — that is the whole
  // point: run N+1 opens with run N's context. The session id lives on the
  // routine; a chat the user deleted is simply replaced.
  let sessionId: string | null = null;
  if (continuous && routine.sessionId && store.get(routine.sessionId))
    sessionId = routine.sessionId;
  const fresh = sessionId === null;
  const session = sessionId
    ? { id: sessionId }
    : store.create(routine.name || "Routine", routine.space);
  // Tag it now, not on success: a run that errors still produced this chat, and
  // the tag is what keeps it out of Recents.
  if (fresh) store.markRoutineChat(session.id, routine.id);
  if (continuous && routine.sessionId !== session.id)
    updateRoutine(routine.id, { sessionId: session.id });
  notify("routines:started", {
    routineId: routine.id,
    sessionId: session.id,
    name: routine.name || "Routine",
  });

  const runOpts = {
    space: routine.space,
    providerId: routine.providerId,
    modelOverride: routine.model,
    permissionMode: "bypassPermissions" as const,
    // This is the one place with no user behind it — tools that need a
    // person (the Routine tool) refuse on this, not on the permission mode.
    unattended: true,
    // Ask-level connector actions run unattended ONLY if granted at
    // creation; destructive is never grantable (the engine enforces both).
    connectorGrants: routine.grants,
    // Off = the run's system prompt carries no long-term memory.
    memory: routine.memory !== false,
    maxTurns: 30,
    // Scope to declared connectors plus every connector needed by the
    // trigger/output. An empty declared scope means the default toolset,
    // but an explicit output/event connector must still be available.
    connectors: (() => {
      const scope = new Set(routine.connectors);
      if (routine.output.kind === "connector" && routine.output.connector)
        scope.add(routine.output.connector);
      if (routine.trigger.kind === "event" && routine.trigger.event?.connector)
        scope.add(routine.trigger.event.connector);
      return [...scope];
    })(),
  };

  /** One agent turn in the routine's chat, events forwarded to the renderer
   * exactly like chat:send — returns the assistant's text. */
  const runTurn = async (prompt: string, display: string): Promise<string> => {
    let text = "";
    // Show the prompt as a user message in the chat.
    notify("chat:token", {
      sessionId: session.id,
      event: { type: "user_message", content: display },
    });
    await runAgent(
      session.id,
      prompt,
      (ev) => {
        if (ev.type === "text_delta") text += ev.text;
        // A run that fails without throwing leaves its chat behind — mark it,
        // the way a hand-driven chat is marked, so the sidebar says so.
        if (ev.type === "error" && ev.error && ev.error !== "Aborted")
          store.setLastError(session.id, ev.error);
        // Same post-mortem trail a hand-driven chat keeps: a routine that
        // came back with nothing must not look like one that finished.
        if (ev.type === "message_stop")
          store.setLastStopReason(
            session.id,
            stopReasonLabel(ev.stop_reason, ev.empty === true),
          );
        notify("chat:token", { sessionId: session.id, event: ev });
      },
      runOpts,
    );
    return text;
  };

  const fail = (err: unknown): RoutineRun => {
    // A fresh chat in per-run mode dies with its failed run; a continuous
    // chat is the routine's home and stays, error mark and all.
    if (!continuous) store.delete(session.id);
    const run: RoutineRun = {
      id: runId,
      routineId: routine.id,
      at,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    recordRun(run);
    updateRoutine(routine.id, { lastRun: at, lastStatus: "error" });
    notify("routines:ran", { routineId: routine.id, status: "error" });
    return run;
  };

  const skipped = (): RoutineRun => {
    if (!continuous) store.delete(session.id); // condition unmet — no chat
    const run: RoutineRun = {
      id: runId,
      routineId: routine.id,
      at,
      status: "skipped",
    };
    recordRun(run);
    updateRoutine(routine.id, { lastRun: at, lastStatus: "skipped" });
    notify("routines:ran", { routineId: routine.id, status: "skipped" });
    return run;
  };

  let assistantText = "";
  if (continuous) {
    // The gate runs as its OWN turn: the user watches the check happen —
    // tools and all — but the turn is then taken out of the model's context
    // (setTurnContext), so a month of "nothing new" checks never crowds the
    // chat the actual work lives in.
    if (useGate) {
      const gatePrompt = [
        ...gates,
        skipInstruction(),
        `If the condition holds, reply with exactly "PROCEED" and nothing else — the task follows as the next message. Do not start the task in this turn.`,
      ].join("\n");
      let gateText = "";
      try {
        gateText = await runTurn(gatePrompt, gatePrompt);
      } catch (err) {
        return fail(err);
      } finally {
        // Out of context either way — a PROCEED turn is as much noise to
        // run N+2 as a SKIP turn.
        try {
          const turns = turnContextState(session.id);
          const last = turns[turns.length - 1];
          if (last) setTurnContext(session.id, last.id, false);
        } catch {
          /* display concern, never fatal */
        }
      }
      if (isSkipSentinel(gateText.trim())) return skipped();
    }
    try {
      assistantText = await runTurn(task, routine.prompt);
    } catch (err) {
      return fail(err);
    }
  } else {
    // Per-run chat: gate and task fold into one prompt, and a SKIP deletes
    // the chat — a run that did nothing leaves nothing.
    let effective = task;
    if (routine.trigger.kind === "event" && gates.length > 0) {
      effective = [gates[0], skipInstruction(), `Otherwise, for the new events, do the following:`, "", effective].join("\n");
    }
    if (routine.condition?.kind === "agent" && routine.condition.prompt)
      effective = withCondition(routine.condition.prompt, effective);
    // The retrospective: what the last runs did (or how they failed) rides
    // into this one, so run N+1 continues instead of restarting. Continuous
    // chats don't need it — their context IS the history.
    try {
      const history = routineHistoryBlock(listRuns(routine.id, 6));
      if (history) effective = `${effective}\n\n${history}`;
    } catch {
      /* continuity, not correctness */
    }
    try {
      assistantText = await runTurn(effective, routine.prompt);
    } catch (err) {
      return fail(err);
    }
    if (useGate && isSkipSentinel(assistantText.trim())) return skipped();
  }

  // Update only the title — chatStore already persisted the full display
  // (user_message, tools, assistant text) via chat:token events.
  store.updateTitle(session.id, routine.name || "Routine");

  const run: RoutineRun = {
    id: runId,
    routineId: routine.id,
    at,
    status: "ok",
    sessionId: session.id,
    summary: assistantText.slice(0, 300),
  };
  recordRun(run);
  updateRoutine(routine.id, { lastRun: at, lastStatus: "ok" });

  // The continuous chat's scheduled haircut: every N recorded runs, compact.
  // Optional — unset means never, and the ordinary in-run compaction still
  // fires when the window actually fills.
  if (continuous && routine.compactEvery && routine.compactEvery > 0) {
    try {
      if (countRuns(routine.id) % routine.compactEvery === 0)
        await compactSessionNow(session.id);
    } catch {
      /* a failed compaction costs nothing — the next one will catch up */
    }
  }

  // Notification output: surface the result as a native OS notification.
  if (routine.output.kind === "notification") {
    try {
      const { Notification } = await import("electron");
      if (Notification.isSupported())
        new Notification({
          title: routine.name || "Routine",
          body: assistantText.trim().slice(0, 220) || "Completed.",
        }).show();
    } catch {
      /* notifications best-effort */
    }
  }

  notify("routines:ran", {
    routineId: routine.id,
    sessionId: session.id,
    status: "ok",
  });
  return run;
}

export function runRoutineNow(id: string): Promise<RoutineRun | null> {
  const r = getRoutine(id);
  return r ? executeRoutine(r) : Promise.resolve(null);
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

export function unschedule(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

export function scheduleRoutine(r: Routine): void {
  unschedule(r.id);
  if (!r.enabled) return;

  // Event trigger: poll the connector on an interval; the run itself detects
  // whether anything is new (and SKIPs otherwise).
  if (r.trigger.kind === "event") {
    const mins = Math.max(1, r.trigger.event?.intervalMinutes ?? 15);
    timers.set(
      r.id,
      setInterval(() => {
        void (async () => {
          const fresh = getRoutine(r.id);
          if (fresh?.enabled)
            await executeRoutine(fresh, { source: "event" }).catch(() => {});
        })();
      }, mins * 60_000),
    );
    return;
  }

  if (r.trigger.kind !== "schedule" || !r.trigger.cron) return;
  const fields = parseCronExpression(r.trigger.cron);
  if (!fields) return;
  const now = new Date();
  const next = computeNextCronRun(fields, now);
  if (!next) return;

  // The cron's own period, measured from the next two occurrences. Both the
  // jitter cap and the missed-run count are relative to it: 10% of a minute
  // and 10% of a week should not be the same offset.
  const after = computeNextCronRun(fields, new Date(next.getTime() + 1000));
  const periodMs = after ? after.getTime() - next.getTime() : 0;

  // A run that came due while the app was closed. Fire it once — before
  // arming the next timer, so the timer below is always in the future.
  const missedRun = catchUpDecision(r.nextRun, r.lastRun, now, periodMs);
  if (missedRun.fire) {
    const dueAt = r.nextRun!;
    void executeRoutine(r, {
      source: "catchup",
      body: catchUpNote(missedRun.missed, dueAt),
    }).catch(() => {});
  } else if (missedRun.reason === "too-old") {
    console.log(
      `[routines] ${r.id}: skipping ${missedRun.missed} missed run(s), oldest due ${r.nextRun} — past the catch-up window`,
    );
  }

  const jitter = stableJitterMs(r.id, periodMs);
  const target = new Date(next.getTime() + jitter);
  // Store the JITTERED time: it is what the UI shows as "next run", and it is
  // when the routine will actually fire.
  updateRoutine(r.id, { nextRun: target.toISOString() });

  const delay = target.getTime() - Date.now();
  const capped = Math.min(Math.max(delay, 1000), MAX_DELAY);
  timers.set(
    r.id,
    setTimeout(() => {
      // Far-future target: this was just a re-arm tick, recompute and wait more.
      if (delay > MAX_DELAY) {
        const fresh = getRoutine(r.id);
        if (fresh) scheduleRoutine(fresh);
        return;
      }
      void fireAndReschedule(r.id);
    }, capped),
  );
}

async function fireAndReschedule(id: string): Promise<void> {
  const r = getRoutine(id);
  if (!r || !r.enabled) return;
  try {
    await executeRoutine(r);
  } catch {
    /* executor already records errors */
  }
  const fresh = getRoutine(id);
  if (fresh) scheduleRoutine(fresh);
}

export function rescheduleRoutine(id: string): void {
  const r = getRoutine(id);
  if (r) scheduleRoutine(r);
}

/** Arm every enabled schedule routine — called once on app startup. */
export function startScheduler(): void {
  for (const r of listRoutines()) scheduleRoutine(r);
}

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
} from "@vendor/utils/cron.js";
import { runAgent } from "../agent/index.js";
import { getProviderManager } from "../provider/manager.js";
import { getSessionStore } from "../session-store.js";
import {
  getRoutine,
  listRoutines,
  recordRun,
  updateRoutine,
  type Routine,
  type RoutineRun,
} from "./store.js";

const timers = new Map<string, NodeJS.Timeout>();
// setTimeout caps at ~24.8 days; re-arm for anything further out.
const MAX_DELAY = 2_000_000_000;
const SKIP_SENTINEL = "SKIP";

/** Accept the historical exact SKIP response, but not prose beginning with it. */
function isSkipSentinel(text: string): boolean {
  return text.trim() === SKIP_SENTINEL;
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

  const provider = getProviderManager().getActive();
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
  let effective = task;
  let useGate = false;

  // Event trigger: poll the connector for anything new since the last check and
  // SKIP when there's nothing — the SKIP path (below) turns that into a no-op.
  if (routine.trigger.kind === "event") {
    const ev = routine.trigger.event;
    const since = routine.lastRun ?? routine.createdAt;
    effective = [
      `Check ${ev?.connector || "the connected service"} for new ${ev?.type || "events"} since ${since}.`,
      ev?.filter ? `Only consider events matching: ${ev.filter}.` : "",
      skipInstruction(),
      `Otherwise, for the new events, do the following:`,
      "",
      effective,
    ]
      .filter(Boolean)
      .join("\n");
    useGate = true;
  }
  // Optional agent condition gate on top.
  if (routine.condition?.kind === "agent" && routine.condition.prompt) {
    effective = withCondition(routine.condition.prompt, effective);
    useGate = true;
  }
  const prompt = effective;

  const session = store.create(routine.name || "Routine", routine.space);
  // Tag it now, not on success: a run that errors still produced this chat, and
  // the tag is what keeps it out of Recents.
  store.markRoutineChat(session.id, routine.id);
  notify("routines:started", {
    routineId: routine.id,
    sessionId: session.id,
    name: routine.name || "Routine",
  });
  let assistantText = "";
  // Show the routine prompt as the initial user message in the chat.
  notify("chat:token", {
    sessionId: session.id,
    event: { type: "user_message", content: routine.prompt },
  });
  try {
    await runAgent(
      session.id,
      prompt,
      (ev) => {
        if (ev.type === "text_delta") assistantText += ev.text;
        // Forward every event to the renderer so chatStore can build the
        // full display (tool calls, tool results) and persist it — same
        // pattern as chat:send in ipc/chat.ts.
        notify("chat:token", { sessionId: session.id, event: ev });
      },
      {
        space: routine.space,
        permissionMode: "bypassPermissions",
        // This is the one place with no user behind it — tools that need a
        // person (CreateRoutine) refuse on this, not on the permission mode.
        unattended: true,
        // Ask-level connector actions run unattended ONLY if granted at
        // creation; destructive is never grantable (the engine enforces both).
        connectorGrants: routine.grants,
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
      },
    );
  } catch (err) {
    store.delete(session.id);
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
  }

  const text = assistantText.trim();
  if (useGate && isSkipSentinel(text)) {
    store.delete(session.id); // condition unmet — no chat
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
  }

  // Update only the title — chatStore already persisted the full display
  // (user_message, tools, assistant text) via chat:token events.
  store.updateTitle(session.id, routine.name || session.title);

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
  const next = computeNextCronRun(fields, new Date());
  if (!next) return;
  updateRoutine(r.id, { nextRun: next.toISOString() });

  const delay = next.getTime() - Date.now();
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

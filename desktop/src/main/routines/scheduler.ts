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
import { getSessionStore, type ChatMessage } from "../session-store.js";
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

function notify(event: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send(event, payload);
}

/** Wrap the task so the agent first evaluates a condition and SKIPs if unmet. */
function withCondition(conditionPrompt: string, task: string): string {
  return [
    `First evaluate this condition: ${conditionPrompt}`,
    `If it does NOT hold, reply with exactly "SKIP" and nothing else — do not perform the task.`,
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
  const base = triggerCtx + routine.prompt;

  const useGate =
    routine.condition?.kind === "agent" && !!routine.condition.prompt;
  const prompt = useGate
    ? withCondition(routine.condition!.prompt!, base)
    : base;

  const session = store.create(routine.name || "Routine", routine.space);
  let assistantText = "";
  try {
    await runAgent(
      session.id,
      prompt,
      (ev) => {
        if (ev.type === "text_delta") assistantText += ev.text;
      },
      {
        space: routine.space,
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        connectors: routine.connectors,
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
  if (useGate && (text === "SKIP" || /^SKIP\b/.test(text))) {
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

  const now = Date.now();
  const messages: ChatMessage[] = [
    { id: randomUUID(), role: "user", content: routine.prompt, timestamp: now },
    {
      id: randomUUID(),
      role: "assistant",
      content: assistantText || "(no output)",
      timestamp: now + 1,
    },
  ];
  store.save({ ...session, title: routine.name || session.title, messages });

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
  if (!r.enabled || r.trigger.kind !== "schedule" || !r.trigger.cron) return;
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

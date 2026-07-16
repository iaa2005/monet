/**
 * Routines IPC — CRUD, manual run, run history, cron preview, and an LLM
 * "draft from natural language" for the "What do you want automated?" box.
 */

import { ipcMain } from "electron";
import { parseCronExpression, computeNextCronRun, cronToHuman } from "@vendor/utils/cron.js";
import {
  listRoutines,
  getRoutine,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  listRuns,
  type Routine,
  type RoutineInput,
} from "../routines/store.js";
import {
  scheduleRoutine,
  rescheduleRoutine,
  unschedule,
  runRoutineNow,
} from "../routines/scheduler.js";
import { getProviderManager } from "../provider/manager.js";
import { createAdapter } from "../llm/adapter.js";
import { getTriggerConfig, triggerBaseUrl } from "../routines/trigger-server.js";
import { randomUUID } from "node:crypto";

function withHuman(r: Routine): Routine & { humanSchedule?: string } {
  if (r.trigger.kind === "schedule" && r.trigger.cron) {
    try {
      return { ...r, humanSchedule: cronToHuman(r.trigger.cron) };
    } catch {
      /* ignore */
    }
  }
  return r;
}

export function registerRoutinesIPC(): void {
  ipcMain.handle("routines:list", () => listRoutines().map(withHuman));
  ipcMain.handle("routines:get", (_e, id: string) => {
    const r = getRoutine(id);
    return r ? withHuman(r) : null;
  });

  ipcMain.handle("routines:create", (_e, input: RoutineInput) => {
    // Webhook routines need a stable secret id embedded in their inbound URL.
    if (input.trigger.kind === "webhook" && !input.trigger.webhookId)
      input = {
        ...input,
        trigger: { ...input.trigger, webhookId: randomUUID().replace(/-/g, "") },
      };
    const r = createRoutine(input);
    scheduleRoutine(r);
    return withHuman(r);
  });

  // Base URL + API key so the editor can show the webhook / API trigger URLs.
  ipcMain.handle("routines:triggerInfo", () => ({
    baseUrl: triggerBaseUrl(),
    apiKey: getTriggerConfig().apiKey,
  }));

  ipcMain.handle(
    "routines:update",
    (_e, id: string, patch: Partial<Routine>) => {
      const r = updateRoutine(id, patch);
      if (r) rescheduleRoutine(id);
      return r ? withHuman(r) : null;
    },
  );

  ipcMain.handle("routines:setEnabled", (_e, id: string, enabled: boolean) => {
    const r = updateRoutine(id, { enabled });
    if (r) rescheduleRoutine(id);
    return r ? withHuman(r) : null;
  });

  ipcMain.handle("routines:delete", (_e, id: string) => {
    unschedule(id);
    return { ok: deleteRoutine(id) };
  });

  ipcMain.handle("routines:runNow", async (_e, id: string) => {
    return runRoutineNow(id);
  });

  ipcMain.handle("routines:listRuns", (_e, id: string) => listRuns(id));

  // Human text + next fire time for a cron, for the editor's live preview.
  ipcMain.handle("routines:cronPreview", (_e, cron: string) => {
    const fields = parseCronExpression(cron);
    if (!fields) return { valid: false as const };
    const next = computeNextCronRun(fields, new Date());
    let human = cron;
    try {
      human = cronToHuman(cron);
    } catch {
      /* keep raw */
    }
    return {
      valid: true as const,
      human,
      next: next ? next.toISOString() : null,
    };
  });

  // Turn a plain-language description into a routine draft (not saved).
  ipcMain.handle(
    "routines:draft",
    async (
      _e,
      description: string,
      space: "home" | "code" = "code",
    ): Promise<{
      ok: boolean;
      draft?: { name: string; prompt: string; cron: string; space: "home" | "code" };
      error?: string;
    }> => {
      const provider = getProviderManager().getActive();
      if (!provider) return { ok: false, error: "No active provider." };
      try {
        const res = await createAdapter(provider).complete({
          model: provider.model,
          system:
            "You turn a user's request into an automation ('routine'). Reply with ONLY a JSON object: " +
            '{"name": short title, "prompt": the full instruction the agent should run each time (imperative, self-contained), ' +
            '"cron": a 5-field cron expression for when it should run in the user\'s LOCAL time (default "0 9 * * 1-5" for weekday mornings if unspecified)}. ' +
            "No markdown, no prose — only the JSON.",
          messages: [{ role: "user", content: description }],
          max_tokens: 500,
        });
        const raw = typeof res.content === "string" ? res.content : "";
        const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
        const parsed = JSON.parse(json) as {
          name?: string;
          prompt?: string;
          cron?: string;
        };
        return {
          ok: true,
          draft: {
            name: (parsed.name || "New routine").slice(0, 80),
            prompt: parsed.prompt || description,
            cron:
              parsed.cron && parseCronExpression(parsed.cron)
                ? parsed.cron
                : "0 9 * * 1-5",
            space,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Draft failed",
        };
      }
    },
  );
}

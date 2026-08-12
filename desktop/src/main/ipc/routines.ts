/**
 * Routines IPC — CRUD, manual run, run history, cron preview, and an LLM
 * "draft from natural language" for the "What do you want automated?" box.
 */

import { ipcMain } from "electron";
import { extractJson } from "../llm/json-extract.js";
import { resolveBackgroundModel } from "../provider/routing.js";
import { parseCronExpression, computeNextCronRun, cronToHuman } from "../engine/utils/cron.js";
import {
  listRoutines,
  getRoutine,
  createRoutine,
  updateRoutine,
  deleteRoutine,
  listRuns,
  listRoutineChats,
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
import { listAccounts } from "../connectors/store.js";
import { allServices } from "../connectors/services/registry.js";
import { actionsForService } from "../connectors/services/types.js";
import { loadConfig } from "../mcp/manager.js";
import { randomUUID } from "node:crypto";

function knownConnectorIds(): Set<string> {
  const ids = new Set(
    listAccounts()
      .filter((account) => account.enabled)
      .map((account) => account.presetId),
  );
  for (const name of Object.keys(loadConfig().mcpServers)) ids.add(name);
  return ids;
}

export interface RoutineDraftConnector {
  id: string;
  label: string;
  description?: string;
  kind: "connector" | "mcp";
  capabilities: string[];
  actions: { id: string; label: string; access: "read" | "write" | "destructive" }[];
}

export interface RoutineDraft {
  name: string;
  prompt: string;
  cron: string;
  space: "home" | "code";
  connectors?: string[];
  output?: { kind: "chat" | "notification" | "connector"; connector?: string };
  grants?: string[];
}

function connectedDraftConnectors(): RoutineDraftConnector[] {
  const services = new Map(allServices().map((service) => [service.id, service]));
  const result: RoutineDraftConnector[] = [];
  const seen = new Set<string>();
  for (const account of listAccounts()) {
    if (!account.enabled || seen.has(account.presetId)) continue;
    seen.add(account.presetId);
    const service = services.get(account.presetId);
    if (!service) continue;
    result.push({
      id: service.id,
      label: service.name,
      description: service.description,
      kind: "connector",
      capabilities: Object.keys(service.capabilities),
      actions: actionsForService(service).map(({ id, label, access }) => ({ id, label, access })),
    });
  }
  for (const id of Object.keys(loadConfig().mcpServers)) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      label: id,
      kind: "mcp",
      capabilities: ["mcp"],
      actions: [{ id: "mcp.use", label: "Use the service's MCP tools", access: "write" }],
    });
  }
  return result;
}

function hydrateDraft(
  parsed: Partial<RoutineDraft>,
  description: string,
  space: "home" | "code",
  available: RoutineDraftConnector[],
): RoutineDraft {
  const ids = new Set(available.map((connector) => connector.id));
  const actions = new Set(available.flatMap((connector) => connector.actions.map((action) => action.id)));
  const connectors = Array.isArray(parsed.connectors)
    ? parsed.connectors.filter((id): id is string => typeof id === "string" && ids.has(id))
    : undefined;
  const output: RoutineDraft["output"] = parsed.output && typeof parsed.output === "object"
    ? {
        kind: parsed.output.kind === "notification" || parsed.output.kind === "connector" ? parsed.output.kind : "chat",
        ...(parsed.output.kind === "connector" && typeof parsed.output.connector === "string" && ids.has(parsed.output.connector)
          ? { connector: parsed.output.connector }
          : {}),
      }
    : undefined;
  const grants = Array.isArray(parsed.grants)
    ? parsed.grants.filter((id): id is string => typeof id === "string" && actions.has(id))
    : undefined;
  return {
    name: (typeof parsed.name === "string" && parsed.name ? parsed.name : "New routine").slice(0, 80),
    prompt: typeof parsed.prompt === "string" && parsed.prompt ? parsed.prompt : description,
    cron: typeof parsed.cron === "string" && parseCronExpression(parsed.cron) ? parsed.cron : "0 9 * * 1-5",
    space,
    ...(connectors ? { connectors } : {}),
    ...(output ? { output } : {}),
    ...(grants ? { grants } : {}),
  };
}

function validateOutputConnector(output: Routine["output"]): void {
  if (output.kind !== "connector") return;
  const connector = output.connector?.trim();
  if (!connector) {
    throw new Error("Output connector must be selected.");
  }
  if (!knownConnectorIds().has(connector)) {
    throw new Error(`Output connector is not connected: ${connector}.`);
  }
}

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
    validateOutputConnector(input.output);
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
      const current = getRoutine(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      validateOutputConnector(next.output);
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
  ipcMain.handle("routines:chats", (_e, space?: string) => listRoutineChats(50, space));

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
      draft?: RoutineDraft;
      error?: string;
    }> => {
      const routed = resolveBackgroundModel();
      if (!routed) return { ok: false, error: "No active provider." };
      const provider = routed.provider;
      try {
        const available = connectedDraftConnectors();
        const connectorContext = available.length
          ? available
              .map((connector) => `${connector.id} (${connector.label}${connector.description ? ` — ${connector.description}` : ""}, ${connector.kind}; capabilities: ${connector.capabilities.join(", ") || "none"}; actions: ${connector.actions.map((action) => `${action.id} [${action.access}]`).join(", ") || "none"})`)
              .join("\n")
          : "(none)";
        const res = await createAdapter(provider).complete({
          model: routed.model,
          system:
            "You turn a user's request into an automation ('routine'). Reply with ONLY a JSON object: " +
            '{"name": short title, "prompt": the full instruction the agent should run each time (imperative, self-contained), ' +
            '"cron": a 5-field cron expression for when it should run in the user\'s LOCAL time (default "0 9 * * 1-5" for weekday mornings if unspecified), "connectors": an array of connector ids from the catalog, "output": {"kind": "chat"|"notification"|"connector", "connector": connector id only for connector output}, "grants": an array of action ids from the catalog to allow for unattended writes}. ' +
            "Use only ids and action ids present in the connected catalog below; omit optional fields when not needed. No secrets, usernames, tokens, or credentials are included or requested. No markdown, no prose — only the JSON.\nConnected catalog:\n" +
            connectorContext,
          messages: [{ role: "user", content: description }],
          // A thinking model spends part of its budget before writing a single
          // character of the answer; 500 left nothing, so the draft came back
          // empty and the form fell back to pasting the raw text.
          max_tokens: 4_000,
        });
        const raw = (typeof res.content === "string" ? res.content : "").trim();
        if (!raw)
          return {
            ok: false,
            error: `${provider.name || "The model"} returned an empty response.`,
          };
        const { value, truncated } = extractJson(raw);
        if (!value)
          return {
            ok: false,
            error: truncated
              ? `${provider.name || "The model"} ran out of output budget before finishing the draft.`
              : `Couldn't read a routine from the reply. First 200 chars: ${raw.slice(0, 200)}`,
          };
        const parsed = value as Partial<RoutineDraft>;
        return { ok: true, draft: hydrateDraft(parsed, description, space, available) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Draft failed",
        };
      }
    },
  );
}

/**
 * Routine — the agent's hands on the routines themselves: list, create,
 * edit, delete. One tool, because "make it hourly instead" and "delete the
 * old digest" are the same conversation as "set this up every morning".
 *
 * It is deliberately the most guarded tool here, because a routine is not an
 * action — it is a standing grant. Routines run unattended with
 * bypassPermissions, so every tool they touch is auto-approved forever after.
 * Three consequences, all enforced below:
 *
 *  - isReadOnly() is true ONLY for `list`. Creating, editing and deleting go
 *    through the permission prompt — that prompt is the ONLY gate between
 *    "the model wrote a cron line" and "an agent runs on your machine every
 *    morning with tools pre-approved". Editing counts fully: a patch can add
 *    grants or change what runs.
 *  - A routine may not touch routines. Inside an unattended run the prompt is
 *    gone, so self-replication — or a routine editing its own grants — would
 *    be unreviewable.
 *  - Deleting also deletes the routine's run history, which is irreversible —
 *    another reason `delete` is never silent.
 *
 * Everything is validated before it reaches the store: a cron that doesn't
 * parse, or a connector that isn't configured, becomes an error the model can
 * fix, not a routine that silently never fires or fires with no tools.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "../engine/Tool.js";
import { lazySchema } from "./lazy-schema.js";
import {
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from "../engine/utils/cron.js";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  updateRoutine,
  type Routine,
  type RoutineInput,
} from "../routines/store.js";
import { listAccounts } from "../connectors/store.js";
import { getService } from "../connectors/services/registry.js";
import { loadConfig } from "../mcp/manager.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function out(text: string, isError = false): { data: Output } {
  return { data: { text, isError } };
}

/** Connector ids a routine may be scoped to: accounts + raw MCP servers. */
function knownConnectors(): string[] {
  const ids = new Set<string>();
  for (const a of listAccounts()) if (a.enabled) ids.add(a.presetId);
  for (const name of Object.keys(loadConfig().mcpServers)) ids.add(name);
  return [...ids];
}

function label(id: string): string {
  return getService(id)?.name ?? id;
}

/** The machine's zone, named and with its offset, e.g. `Europe/Moscow (UTC+3)`. */
function localZone(): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  // getTimezoneOffset is minutes BEHIND UTC, so the sign is inverted.
  const mins = -new Date().getTimezoneOffset();
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${name} (UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""})`;
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(["list", "create", "update", "delete"])
      .describe(
        "list = enumerate routines (with ids); create = new routine; update = patch an existing one; delete = remove one (and its run history).",
      ),
    id: z
      .string()
      .optional()
      .describe("update/delete: the routine id, as returned by list."),
    name: z
      .string()
      .optional()
      .describe("Short human name, e.g. “Morning news digest”."),
    prompt: z
      .string()
      .optional()
      .describe(
        "What the agent should do on every run. Write it as a standalone instruction — a per-run-chat routine starts with no history behind it.",
      ),
    trigger: z
      .enum(["schedule", "event", "manual", "webhook"])
      .optional()
      .describe("How it fires. Default schedule."),
    cron: z
      .string()
      .optional()
      .describe(
        "schedule: 5-field cron in LOCAL time, e.g. “0 9 * * 1-5” for weekdays at 09:00.",
      ),
    eventConnector: z
      .string()
      .optional()
      .describe("event: connector id to poll, e.g. gmail."),
    eventType: z
      .string()
      .optional()
      .describe("event: what counts as an event, e.g. “new unread email”."),
    eventIntervalMinutes: z
      .number()
      .optional()
      .describe("event: how often to poll. Default 15."),
    eventFilter: z
      .string()
      .optional()
      .describe("event: only consider events matching this."),
    space: z
      .enum(["home", "code"])
      .optional()
      .describe("Where it runs. Defaults to the current chat's space."),
    connectors: z
      .array(z.string())
      .optional()
      .describe(
        "Connector ids the routine may use. Empty = the default toolset. Scope it to what the task needs.",
      ),
    grants: z
      .array(z.string())
      .optional()
      .describe(
        "Connector action ids granted for unattended use (e.g. chat.send, mail.send). Without a grant, ask-level actions are DENIED when the routine fires. Destructive actions can never be granted. Confirm each grant with the user.",
      ),
    condition: z
      .string()
      .optional()
      .describe(
        "Optional gate: the agent checks this first and skips the run when it doesn't hold.",
      ),
    output: z
      .enum(["chat", "notification", "connector"])
      .optional()
      .describe("Where the result goes. Default chat."),
    outputConnector: z
      .string()
      .optional()
      .describe("output=connector: which connector to post the result to."),
    chat: z
      .enum(["new", "continuous"])
      .optional()
      .describe(
        "new (default): every run is a fresh chat. continuous: all runs continue ONE chat, so each run remembers the previous ones.",
      ),
    compactEvery: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "continuous only: compact the shared chat after every N runs. Omit for never (the chat still compacts itself when its context fills).",
      ),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;
type Input = z.infer<InputSchema>;

function describeRoutine(r: Routine): string {
  const when =
    r.trigger.kind === "schedule" && r.trigger.cron
      ? (() => {
          try {
            return cronToHuman(r.trigger.cron);
          } catch {
            return r.trigger.cron;
          }
        })()
      : r.trigger.kind;
  return [
    `${r.name} — id: ${r.id}`,
    `  ${r.enabled ? "enabled" : "DISABLED"}; ${when}; space: ${r.space}; chat: ${r.chat ?? "new"}${
      r.chat === "continuous" && r.compactEvery ? ` (compact every ${r.compactEvery} runs)` : ""
    }`,
    `  task: ${r.prompt.length > 120 ? `${r.prompt.slice(0, 120)}…` : r.prompt}`,
    r.connectors.length ? `  connectors: ${r.connectors.join(", ")}` : "",
    r.grants?.length ? `  unattended grants: ${r.grants.join(", ")}` : "",
    r.lastRun ? `  last run: ${r.lastRun} (${r.lastStatus ?? "?"})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Validate the cross-cutting invariants of a routine about to be written.
 * Returns an error string, or null when everything holds. */
async function validate(r: RoutineInput): Promise<string | null> {
  if (r.trigger.kind === "schedule") {
    if (!r.trigger.cron) return "A schedule trigger needs `cron`.";
    const fields = parseCronExpression(r.trigger.cron);
    if (!fields)
      return `“${r.trigger.cron}” isn't a valid 5-field cron expression.`;
    // Prove it actually fires — a syntactically fine cron like "0 0 30 2 *"
    // never comes round, and a routine that never runs is worse than an error.
    if (!computeNextCronRun(fields, new Date()))
      return `“${r.trigger.cron}” parses but never comes round — pick a schedule that can fire.`;
  }
  if (r.trigger.kind === "event" && !r.trigger.event?.connector)
    return "An event trigger needs `eventConnector`.";

  // A routine scoped to a connector that doesn't exist would run with no tools
  // and quietly do nothing — fail now, while the model can still fix it.
  const known = knownConnectors();
  const unknown = [
    ...r.connectors,
    ...(r.trigger.event?.connector ? [r.trigger.event.connector] : []),
    ...(r.output.connector ? [r.output.connector] : []),
  ].filter((c) => !known.includes(c));
  if (unknown.length > 0)
    return (
      `Not connected: ${unknown.join(", ")}. ` +
      `Available: ${known.join(", ") || "(none)"}. Add it in Settings → Connectors first.`
    );

  if (r.output.kind === "connector" && !r.output.connector)
    return "output=connector needs `outputConnector`.";

  // Grants: must name real actions, and never destructive ones — an
  // unattended run with a standing right to delete is not a thing we mint.
  if (r.grants?.length) {
    const { findAction } = await import("../connectors/services/types.js");
    const bogus = r.grants.filter((g) => !findAction(g));
    if (bogus.length > 0)
      return `Unknown action id(s): ${bogus.join(", ")}. Grants use "<capability>.<op>" ids like chat.send or mail.send.`;
    const destructive = r.grants.filter(
      (g) => findAction(g)?.access === "destructive",
    );
    if (destructive.length > 0)
      return `Destructive actions can't be granted to unattended runs: ${destructive.join(", ")}.`;
  }
  return null;
}

/** The input's routine fields folded over a base (empty for create, the
 * current routine for update). Only fields PRESENT in the input change. */
function applyInput(base: RoutineInput, input: Input): RoutineInput {
  const kind = input.trigger ?? base.trigger.kind;
  const trigger: RoutineInput["trigger"] = { kind };
  if (kind === "schedule") trigger.cron = input.cron ?? base.trigger.cron;
  if (kind === "event")
    trigger.event = {
      connector: input.eventConnector ?? base.trigger.event?.connector ?? "",
      type: input.eventType ?? base.trigger.event?.type ?? "new items",
      intervalMinutes:
        input.eventIntervalMinutes ?? base.trigger.event?.intervalMinutes ?? 15,
      filter: input.eventFilter ?? base.trigger.event?.filter,
    };
  if (kind === "webhook") trigger.webhookId = base.trigger.webhookId;
  return {
    name: (input.name ?? base.name).trim() || "Routine",
    prompt: input.prompt ?? base.prompt,
    space: input.space ?? base.space,
    connectors: input.connectors ?? base.connectors,
    grants: input.grants ?? base.grants,
    memory: base.memory,
    providerId: base.providerId,
    model: base.model,
    chat: input.chat ?? base.chat ?? "new",
    compactEvery: input.compactEvery ?? base.compactEvery,
    trigger,
    condition:
      input.condition !== undefined
        ? { kind: "agent", prompt: input.condition }
        : (base.condition ?? { kind: "always" }),
    output: {
      kind: input.output ?? base.output.kind,
      ...((input.outputConnector ?? base.output.connector)
        ? { connector: input.outputConnector ?? base.output.connector }
        : {}),
    },
    enabled: base.enabled,
  };
}

export const RoutineTool = buildTool({
  name: "Routine",
  searchHint: "list, create, edit or delete scheduled routines",
  maxResultSizeChars: 12_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Routine";
  },
  isReadOnly(input?: unknown) {
    // Listing changes nothing and needs no prompt; everything else is a
    // standing grant and ALWAYS asks.
    return (input as Input | undefined)?.action === "list";
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-routine",
        [
          "Manage routines: tasks that run on a schedule, on a connector",
          "event, by webhook, or manually. `list` shows them with ids;",
          "`create` adds one; `update` patches the named fields of one;",
          "`delete` removes one along with its run history.",
          "Write `prompt` as a self-contained instruction. `chat: continuous`",
          "makes every run continue ONE chat (the run remembers previous",
          "runs); the default `new` starts a fresh chat each time. Routines",
          "run unattended: read actions work, but ask-level actions (send a",
          "message, send mail, upload) are DENIED unless listed in `grants` —",
          "confirm each grant, the schedule and the task with the user before",
          "creating or changing one, and never touch one they didn't ask",
          "about.",
        ].join(" "),
      ),
      // Spelled out because the model otherwise guesses, and guesses wrong: it
      // converts to UTC "in case the server runs on it" and the routine fires
      // hours off. Cron here is evaluated in the machine's own zone.
      `Cron is 5-field and runs in THIS machine's local time — ${localZone()}. Do not convert to UTC.`,
      `Connectors available: ${knownConnectors().map(label).join(", ") || "(none)"}.`,
    ].join("\n");
  },
  async description() {
    return "List, create, edit or delete routines — agent tasks that run on a schedule or trigger.";
  },
  async call(input: Input, context: ToolUseContext) {
    // Only a routine firing on its own counts as unattended. A user with "Skip
    // all approvals" on is still present, and this used to refuse them.
    if (
      input.action !== "list" &&
      (context as { unattended?: boolean }).unattended === true
    ) {
      return out(
        "Routines can't create, edit or delete routines — there's no one present to approve a change to a standing task. Ask the user to do it themselves.",
        true,
      );
    }

    if (input.action === "list") {
      const all = listRoutines();
      return out(
        all.length === 0
          ? "No routines yet."
          : all.map(describeRoutine).join("\n\n"),
      );
    }

    if (input.action === "delete") {
      if (!input.id) return out("`delete` needs `id` (see `list`).", true);
      const r = getRoutine(input.id);
      if (!r) return out(`No routine with id ${input.id}.`, true);
      const { unschedule } = await import("../routines/scheduler.js");
      unschedule(r.id);
      deleteRoutine(r.id);
      return out(`Deleted “${r.name}” and its run history.`);
    }

    // create / update share the assembly and the validation.
    let base: RoutineInput;
    let existingId: string | null = null;
    if (input.action === "update") {
      if (!input.id) return out("`update` needs `id` (see `list`).", true);
      const cur = getRoutine(input.id);
      if (!cur) return out(`No routine with id ${input.id}.`, true);
      existingId = cur.id;
      base = cur;
    } else {
      if (!input.name?.trim()) return out("`create` needs `name`.", true);
      if (!input.prompt?.trim()) return out("`create` needs `prompt`.", true);
      base = {
        name: "",
        prompt: "",
        space:
          input.space ??
          ((context as { space?: string }).space === "home" ? "home" : "code"),
        connectors: [],
        trigger: { kind: input.trigger ?? "schedule" },
        condition: { kind: "always" },
        output: { kind: "chat" },
        enabled: true,
      };
    }

    const next = applyInput(base, input);
    const problem = await validate(next);
    if (problem) return out(problem, true);

    try {
      // Imported lazily on purpose: the scheduler pulls in the whole agent to
      // run a routine, and this tool is loaded BY the agent — a static import
      // would close the loop (vendor-tools → here → scheduler → agent).
      const { scheduleRoutine } = await import("../routines/scheduler.js");
      const saved = existingId
        ? updateRoutine(existingId, next)
        : createRoutine(next);
      if (!saved) return out("The routine disappeared mid-update.", true);
      scheduleRoutine(saved); // arm it now, don't wait for a restart

      const kind = saved.trigger.kind;
      const lines = [
        `${existingId ? "Updated" : "Created"} “${saved.name}” (${saved.space}).`,
        kind === "schedule" && saved.trigger.cron
          ? `Runs ${cronToHuman(saved.trigger.cron)} — ${localZone()}.`
          : kind === "event"
            ? `Polls ${label(saved.trigger.event?.connector ?? "")} every ${saved.trigger.event?.intervalMinutes ?? 15} min for ${saved.trigger.event?.type ?? "new items"}.`
            : `Trigger: ${kind}.`,
        saved.chat === "continuous"
          ? `Runs continue one chat${saved.compactEvery ? `, compacted every ${saved.compactEvery} runs` : ""}.`
          : "Each run opens a fresh chat.",
        saved.connectors.length
          ? `Connectors: ${saved.connectors.map(label).join(", ")}.`
          : "Connectors: default toolset.",
        saved.grants?.length
          ? `Granted unattended: ${saved.grants.join(", ")}.`
          : "No write actions granted — ask-level actions will be denied when it fires.",
        saved.condition?.kind === "agent" && saved.condition.prompt
          ? `Only when: ${saved.condition.prompt}`
          : "",
        `Manage it in Routines.`,
      ].filter(Boolean);
      return out(lines.join("\n"));
    } catch (e) {
      return out(e instanceof Error ? e.message : String(e), true);
    }
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});

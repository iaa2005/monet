/**
 * CreateRoutine — let the agent turn "every weekday at 9, mail me the news"
 * into a real routine instead of walking the user through the editor.
 *
 * This tool is deliberately the most guarded one here, because a routine is not
 * an action — it is a standing grant. Routines run unattended with
 * bypassPermissions, so every tool they touch is auto-approved forever after.
 * Two consequences, both enforced below:
 *
 *  - isReadOnly() is false, so creating one always goes through the permission
 *    prompt. That prompt is the ONLY gate between "the model wrote a cron line"
 *    and "an agent runs on your machine every morning with tools pre-approved".
 *  - A routine may not create routines. Inside an unattended run the prompt is
 *    gone, so self-replication would be unreviewable — and a routine that
 *    spawns routines is a foot-gun with no upside.
 *
 * Everything is validated before it reaches the store: a cron that doesn't
 * parse, or a connector that isn't configured, becomes an error the model can
 * fix, not a routine that silently never fires or fires with no tools.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from "@vendor/utils/cron.js";
import { createRoutine, type RoutineInput } from "../routines/store.js";
import { listAccounts } from "../connectors/store.js";
import { getService } from "../connectors/services/registry.js";
import { loadConfig } from "../mcp/manager.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
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
    name: z.string().describe("Short human name, e.g. “Morning news digest”."),
    prompt: z
      .string()
      .describe(
        "What the agent should do on every run. Write it as a standalone instruction — the routine runs with no chat history behind it.",
      ),
    trigger: z
      .enum(["schedule", "event", "manual", "webhook"])
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
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

export const CreateRoutineTool = buildTool({
  name: "CreateRoutine",
  searchHint: "create a scheduled or event-triggered routine",
  maxResultSizeChars: 8_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Create Routine";
  },
  isReadOnly() {
    return false; // a standing grant — always ask
  },
  isConcurrencySafe() {
    return false;
  },
  async prompt() {
    return [
      tunablePrompt(
        "tool-create-routine",
        [
          "Create a routine: a task that runs on a schedule, on a connector",
          "event, by webhook, or manually. Write `prompt` as a self-contained",
          "instruction — a routine starts with an empty conversation, so it",
          "cannot refer to “this chat” or anything discussed here. Scope",
          "`connectors` to what the task actually needs. Routines run",
          "unattended with tools pre-approved, so confirm the schedule and the",
          "task with the user before creating one, and never create one they",
          "didn't ask for.",
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
    return "Create a scheduled/event-triggered routine that runs an agent task unattended.";
  },
  async call(input: z.infer<InputSchema>, context: ToolUseContext) {
    // Only a routine firing on its own counts as unattended. A user with "Skip
    // all approvals" on is still present, and this used to refuse them.
    if ((context as { unattended?: boolean }).unattended === true) {
      return {
        data: {
          text: "Routines can't create routines — there's no one present to approve a new standing task. Ask the user to add it themselves.",
          isError: true,
        },
      };
    }

    const kind = input.trigger ?? "schedule";
    let human = "";
    let next = "";

    if (kind === "schedule") {
      if (!input.cron)
        return { data: { text: "A schedule trigger needs `cron`.", isError: true } };
      const fields = parseCronExpression(input.cron);
      if (!fields)
        return {
          data: {
            text: `“${input.cron}” isn't a valid 5-field cron expression.`,
            isError: true,
          },
        };
      // Prove it actually fires — a syntactically fine cron like "0 0 30 2 *"
      // never comes round, and a routine that never runs is worse than an error.
      const when = computeNextCronRun(fields, new Date());
      if (!when)
        return {
          data: {
            text: `“${input.cron}” parses but never comes round — pick a schedule that can fire.`,
            isError: true,
          },
        };
      human = cronToHuman(input.cron);
      next = when.toISOString();
    }

    if (kind === "event" && !input.eventConnector)
      return {
        data: { text: "An event trigger needs `eventConnector`.", isError: true },
      };

    // A routine scoped to a connector that doesn't exist would run with no tools
    // and quietly do nothing — fail now, while the model can still fix it.
    const known = knownConnectors();
    const unknown = [
      ...(input.connectors ?? []),
      ...(input.eventConnector ? [input.eventConnector] : []),
      ...(input.outputConnector ? [input.outputConnector] : []),
    ].filter((c) => !known.includes(c));
    if (unknown.length > 0)
      return {
        data: {
          text:
            `Not connected: ${unknown.join(", ")}. ` +
            `Available: ${known.join(", ") || "(none)"}. Add it in Settings → Connectors first.`,
          isError: true,
        },
      };

    if (input.output === "connector" && !input.outputConnector)
      return {
        data: {
          text: "output=connector needs `outputConnector`.",
          isError: true,
        },
      };

    const space =
      input.space ?? ((context as { space?: string }).space === "home" ? "home" : "code");

    const routine: RoutineInput = {
      name: input.name.trim() || "Routine",
      prompt: input.prompt,
      space,
      connectors: input.connectors ?? [],
      trigger: {
        kind,
        ...(kind === "schedule" ? { cron: input.cron } : {}),
        ...(kind === "event"
          ? {
              event: {
                connector: input.eventConnector as string,
                type: input.eventType ?? "new items",
                intervalMinutes: input.eventIntervalMinutes ?? 15,
                filter: input.eventFilter,
              },
            }
          : {}),
      },
      condition: input.condition
        ? { kind: "agent", prompt: input.condition }
        : { kind: "always" },
      output: {
        kind: input.output ?? "chat",
        ...(input.outputConnector ? { connector: input.outputConnector } : {}),
      },
      enabled: true,
    };

    try {
      const created = createRoutine(routine);
      // Imported lazily on purpose: the scheduler pulls in the whole agent to
      // run a routine, and this tool is loaded BY the agent — a static import
      // would close the loop (vendor-tools → here → scheduler → agent).
      const { scheduleRoutine } = await import("../routines/scheduler.js");
      scheduleRoutine(created); // arm it now, don't wait for a restart
      const lines = [
        `Created “${created.name}” (${space}).`,
        kind === "schedule"
          ? `Runs ${human} — ${localZone()}. Next: ${next}.`
          : kind === "event"
            ? `Polls ${label(input.eventConnector as string)} every ${input.eventIntervalMinutes ?? 15} min for ${input.eventType ?? "new items"}.`
            : `Trigger: ${kind}.`,
        input.connectors?.length
          ? `Connectors: ${input.connectors.map(label).join(", ")}.`
          : "Connectors: default toolset.",
        input.condition ? `Only when: ${input.condition}` : "",
        `Manage it in Routines.`,
      ].filter(Boolean);
      return { data: { text: lines.join("\n"), isError: false } };
    } catch (e) {
      return {
        data: {
          text: e instanceof Error ? e.message : String(e),
          isError: true,
        },
      };
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

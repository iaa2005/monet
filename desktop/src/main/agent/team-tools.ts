/**
 * Team tools — address the background agents instead of just firing them.
 *
 * `Task(run_in_background)` already gave parallelism, but the agents were
 * anonymous: nothing could correct one mid-flight, and two of them could not
 * hand anything to each other. Naming them and giving each a mailbox is what
 * turns a set of detached tasks into a team.
 *
 * The vendor's swarm additionally spawns teammates in tmux panes with their own
 * REPLs; that shape has no meaning in this app, so the mailbox is in-process
 * and messages are delivered at a turn boundary — a mid-turn arrival would
 * break the tool_use/tool_result pairing the API requires.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { listTeam, sendToMember, stopMember } from "./bg-agents.js";
import { tunablePrompt } from "../prompts/index.js";

interface Output {
  text: string;
  isError: boolean;
}

function out(text: string, isError = false): { data: Output } {
  return { data: { text, isError } };
}

function sessionOf(context: ToolUseContext): string {
  return (context as { sessionId?: string }).sessionId ?? "default";
}

// ─── SendMessage ────────────────────────────────────────────────────────────

const sendSchema = lazySchema(() =>
  z.strictObject({
    to: z
      .string()
      .describe(
        "Name of the running agent to message, as shown by TeamList (e.g. \"explore\", \"explore-2\").",
      ),
    message: z
      .string()
      .describe(
        "What to tell it. Be specific and self-contained — it cannot see your conversation.",
      ),
  }),
);

type SendSchema = ReturnType<typeof sendSchema>;

export const SendMessageTool = buildTool({
  name: "SendMessage",
  searchHint: "send an instruction to a running background agent",
  maxResultSizeChars: 1_000,
  get inputSchema(): SendSchema {
    return sendSchema();
  },
  userFacingName() {
    return "SendMessage";
  },
  isReadOnly() {
    return true; // queues text; the recipient decides what to do
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-send-message",
      [
        "Send a message to one of your running background agents.",
        "",
        "Use it to correct or re-scope work already in flight — a constraint you",
        "forgot, a file it should skip, a finding from another agent that changes",
        "its job. The message lands in that agent's inbox and it reads it at its",
        "next step, so it will not interrupt a tool call mid-flight.",
        "",
        "Call TeamList first if you are not sure who is running. Messaging a name",
        "that is not running fails rather than going nowhere quietly.",
      ].join("\n"),
    );
  },
  async description() {
    return "Send an instruction to a running background agent by name.";
  },
  async call(input: z.infer<SendSchema>, context: ToolUseContext) {
    const sessionId = sessionOf(context);
    const ok = sendToMember(sessionId, input.to, "the main agent", input.message);
    if (!ok) {
      const running = listTeam(sessionId).map((m) => m.name);
      return out(
        running.length
          ? `No running agent named "${input.to}". Currently running: ${running.join(", ")}.`
          : `No running agent named "${input.to}" — nothing is running right now.`,
        true,
      );
    }
    return out(`Delivered to "${input.to}". It will read the message at its next step.`);
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

// ─── TeamList ───────────────────────────────────────────────────────────────

const teamSchema = lazySchema(() =>
  z.strictObject({
    stop: z
      .string()
      .optional()
      .describe(
        "Name of an agent to stop. Omit to just list. Stopping is immediate and its work is lost.",
      ),
  }),
);

type TeamSchema = ReturnType<typeof teamSchema>;

export const TeamListTool = buildTool({
  name: "TeamList",
  searchHint: "list the background agents running right now",
  maxResultSizeChars: 2_000,
  get inputSchema(): TeamSchema {
    return teamSchema();
  },
  userFacingName() {
    return "TeamList";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-team-list",
      [
        "List the background agents running for this conversation, with the name",
        "SendMessage uses to address each one and how long it has been going.",
        "",
        "Pass `stop` with a name to end one early — when its work is no longer",
        "needed, or it is clearly off track. Its progress is lost, so prefer",
        "SendMessage to redirect it when the work is still worth having.",
      ].join("\n"),
    );
  },
  async description() {
    return "List running background agents, and optionally stop one.";
  },
  async call(input: z.infer<TeamSchema>, context: ToolUseContext) {
    const sessionId = sessionOf(context);
    if (input.stop) {
      const stopped = stopMember(sessionId, input.stop);
      if (!stopped) return out(`No running agent named "${input.stop}".`, true);
      return out(`Stopped "${input.stop}".`);
    }
    const members = listTeam(sessionId);
    if (members.length === 0) return out("No background agents are running.");
    const lines = members.map((m) => {
      const secs = Math.round((Date.now() - m.startedAt) / 1000);
      const waiting = m.inbox.length > 0 ? `, ${m.inbox.length} unread` : "";
      return `- ${m.name} (${m.agentType}) — running ${secs}s${waiting}${m.description ? `: ${m.description}` : ""}`;
    });
    return out(`Running background agents:\n${lines.join("\n")}`);
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

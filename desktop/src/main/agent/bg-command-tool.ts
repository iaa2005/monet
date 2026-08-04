/**
 * RunCommandBackground + BackgroundOutput — the sandbox in the background.
 *
 * A pip install or a long build inside RunCommand holds the whole turn
 * hostage. These two split it: start detached, keep narrating and doing
 * other steps, collect the tail when it matters. Same shape the desktop's
 * own tooling uses (run_in_background + a later output check), so the
 * model already knows the dance.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { getSessionEngine } from "../sandbox/config.js";
import { startBgCommand, bgStatus } from "../sandbox/bg-tasks.js";
import { tunablePrompt } from "../prompts/index.js";

const startSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe("The shell command to run in the sandbox, detached."),
  }),
);
type StartSchema = ReturnType<typeof startSchema>;

export const RunCommandBackgroundTool = buildTool({
  name: "RunCommandBackground",
  searchHint: "run a long sandbox command in the background",
  maxResultSizeChars: 4_000,
  get inputSchema(): StartSchema {
    return startSchema();
  },
  userFacingName() {
    return "Run in background";
  },
  isReadOnly() {
    return false;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-run-command-background",
      [
        "Start a shell command in the Podman sandbox WITHOUT waiting for it —",
        "installs, builds, downloads that take minutes. Returns a taskId at",
        "once; keep working and check on it with BackgroundOutput between",
        "steps. Same /work folder and persistent pip as RunCommand, so what a",
        "background install puts in place is visible to every later command.",
        "For servers use ServeSandbox instead — this is for commands that END.",
      ].join(" "),
    );
  },
  async description() {
    return "Start a sandbox command in the background (returns a taskId).";
  },
  async call({ command }: z.infer<StartSchema>, context: ToolUseContext) {
    const sessionId = (context as { sessionId?: string }).sessionId || "default";
    if (getSessionEngine(sessionId) !== "docker") {
      return {
        data: {
          text: "RunCommandBackground needs the Podman sandbox engine.",
          isError: true,
        },
      };
    }
    const r = await startBgCommand(sessionId, command);
    if (!r.ok) return { data: { text: r.error ?? "Failed to start.", isError: true } };
    return {
      data: {
        text: `Started in the background: taskId ${r.taskId}. Check it with BackgroundOutput when you need the result.`,
      },
    };
  },
  mapToolResultToToolResultBlockParam(content: { text: string; isError?: boolean }, toolUseID: string): ToolResultBlockParam {
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

const outputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z.string().describe("The taskId RunCommandBackground returned."),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export const BackgroundOutputTool = buildTool({
  name: "BackgroundOutput",
  searchHint: "check a background sandbox command's output",
  maxResultSizeChars: 30_000,
  get inputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Background output";
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return tunablePrompt(
      "tool-background-output",
      [
        "Check a background sandbox task. While it runs you get the log tail —",
        "do other useful work between checks instead of polling in a tight",
        "loop. Once it has exited you get the exit code and final tail, and",
        "the task is collected (a second check will not find it).",
      ].join(" "),
    );
  },
  async description() {
    return "Log tail and status of a background sandbox command.";
  },
  async call({ taskId }: z.infer<OutputSchema>) {
    const s = await bgStatus(taskId);
    if (!s.ok) return { data: { text: s.error ?? "Unknown task.", isError: true } };
    const head = s.running
      ? `Still running (${s.seconds}s).`
      : `Finished with exit code ${s.exitCode} after ${s.seconds}s.`;
    return {
      data: { text: `${head}\n${s.tail ? `--- tail ---\n${s.tail}` : "(no output yet)"}` },
    };
  },
  mapToolResultToToolResultBlockParam(content: { text: string; isError?: boolean }, toolUseID: string): ToolResultBlockParam {
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

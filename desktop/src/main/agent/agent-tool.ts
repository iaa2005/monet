/**
 * Task tool (desktop-native sub-agent launcher).
 *
 * Lets the main model delegate a self-contained, multi-step task to a child
 * agent that runs autonomously with its own context and the full toolset
 * (minus Task itself). The child's final report is returned as the tool
 * result. Backed by runSubAgent — see subagent.ts.
 */

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolUseContext } from "@vendor/Tool.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import { runSubAgent } from "./subagent.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    description: z
      .string()
      .describe("A short (3-5 word) description of the task."),
    prompt: z
      .string()
      .describe(
        "The full task for the sub-agent to perform autonomously. Be detailed: the sub-agent starts with no prior context beyond this prompt and returns a single final report.",
      ),
    subagent_type: z
      .string()
      .optional()
      .describe("Optional agent type hint (currently informational)."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

interface TaskOutput {
  report: string;
}

export const AgentTaskTool = buildTool({
  name: "Task",
  aliases: ["Agent"],
  searchHint: "launch an autonomous sub-agent for a multi-step task",
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  userFacingName() {
    return "Task";
  },
  isConcurrencySafe() {
    return true;
  },
  async prompt() {
    return [
      "Launch a sub-agent to autonomously handle a complex, multi-step task and",
      "report back. The sub-agent has the same tools (except launching further",
      "sub-agents) and its own separate context, so it's ideal for open-ended",
      "searches or self-contained subtasks that would otherwise fill the main",
      "conversation. Give it a complete, standalone `prompt` — it sees no prior",
      "context — and it returns a single final report. It cannot ask follow-up",
      "questions, so include everything it needs.",
    ].join("\n");
  },
  async description() {
    return "Launch an autonomous sub-agent to handle a multi-step task and return its report.";
  },
  async call({ prompt }: z.infer<InputSchema>, context: ToolUseContext) {
    const model = context.options.mainLoopModel;
    const signal = context.abortController.signal;
    const onProgress = (context as Record<string, unknown>)
      ._subAgentOnProgress as ((text: string) => void) | undefined;
    const report = await runSubAgent({ prompt, model, signal, onProgress });
    return { data: { report } };
  },
  mapToolResultToToolResultBlockParam(
    content: TaskOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: content.report,
    };
  },
  renderToolUseMessage() {
    return null;
  },
});

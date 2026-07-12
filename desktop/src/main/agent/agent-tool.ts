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
import { getWorkspacePath } from "../ipc/workspace.js";
import {
  describeAgentsForPrompt,
  resolveAgentDefinition,
} from "./agent-defs.js";
import { runSubAgent, type SubAgentUpdate } from "./subagent.js";

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
      .describe(
        "Which agent type to use — one of the types listed in this tool's description. Defaults to general-purpose.",
      ),
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
      "report back. The sub-agent has its own separate context and toolset (it",
      "cannot launch further sub-agents), so it's ideal for open-ended searches",
      "or self-contained subtasks that would otherwise fill the main",
      "conversation. Give it a complete, standalone `prompt` — it sees no prior",
      "context — and it returns a single final report. It cannot ask follow-up",
      "questions, so include everything it needs.",
      "",
      "Pick the `subagent_type` that best fits the task:",
      "",
      describeAgentsForPrompt(getWorkspacePath()),
    ].join("\n");
  },
  async description() {
    return "Launch an autonomous sub-agent to handle a multi-step task and return its report.";
  },
  async call(
    { prompt, description, subagent_type }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const model = context.options.mainLoopModel;
    const signal = context.abortController.signal;
    const emit = (context as Record<string, unknown>)._subAgentEmit as
      | ((update: SubAgentUpdate) => void)
      | undefined;
    const def = resolveAgentDefinition(subagent_type, getWorkspacePath());
    emit?.({ kind: "start", agentType: def.type, description });
    try {
      const report = await runSubAgent({ prompt, model, def, signal, emit });
      return { data: { report } };
    } finally {
      emit?.({ kind: "done" });
    }
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

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
import { getCwd } from "@vendor/utils/cwd.js";
import { lazySchema } from "@vendor/utils/lazySchema.js";
import {
  describeAgentsForPrompt,
  resolveAgentDefinition,
} from "./agent-defs.js";
import {
  pushBgResult,
  registerBgAgent,
  unregisterBgAgent,
} from "./bg-agents.js";
import { runSubAgent, type SubAgentUpdate } from "./subagent.js";

// Read the effective cwd from the vendor context so packaged builds and
// concurrent runs use the selected workspace rather than the install folder.
function workspaceDir(): string {
  return getCwd();
}

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
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        "Run the sub-agent in the background and return immediately. Use for long, independent work you don't need the result of right now — its report is delivered to you automatically when it finishes.",
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
      describeAgentsForPrompt(workspaceDir()),
    ].join("\n");
  },
  async description() {
    return "Launch an autonomous sub-agent to handle a multi-step task and return its report.";
  },
  async call(
    {
      prompt,
      description,
      subagent_type,
      run_in_background,
    }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const model = context.options.mainLoopModel;
    const cwd = workspaceDir();
    const emit = (context as Record<string, unknown>)._subAgentEmit as
      | ((update: SubAgentUpdate) => void)
      | undefined;
    const def = resolveAgentDefinition(subagent_type, cwd);

    // Background: run detached under its own controller (a new user send
    // aborts the turn's signal, but background work must survive that), report
    // back via the pending queue when it finishes. The card keeps updating
    // live because the emit channel outlives the turn.
    if (run_in_background) {
      const sessionId =
        (context as { sessionId?: string }).sessionId ?? "default";
      const controller = new AbortController();
      registerBgAgent(sessionId, controller);
      emit?.({ kind: "start", agentType: def.type, description, background: true });
      void runSubAgent({
        prompt,
        model,
        def,
        signal: controller.signal,
        emit,
        cwd,
      })
        .then((report) => {
          // Queue BEFORE notifying the UI so an idle auto-continue that fires
          // on the "done" event always finds the result in the pending queue.
          pushBgResult(sessionId, def.type, description ?? "", report);
          emit?.({ kind: "done" });
        })
        .catch((err) => {
          pushBgResult(
            sessionId,
            def.type,
            description ?? "",
            `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
          );
          emit?.({ kind: "done" });
        })
        .finally(() => unregisterBgAgent(sessionId, controller));
      return {
        data: {
          report:
            `Launched sub-agent "${def.type}" in the background` +
            (description ? ` for: ${description}` : "") +
            `. Continue with other work — its report will be delivered to you when it finishes.`,
        },
      };
    }

    const signal = context.abortController.signal;
    emit?.({ kind: "start", agentType: def.type, description });
    try {
      const report = await runSubAgent({ prompt, model, def, signal, emit, cwd });
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

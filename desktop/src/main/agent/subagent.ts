/**
 * Sub-agent runner.
 *
 * The vendor AgentTool spawns children through the vendor query engine (which
 * we don't use). This runs a nested agent loop against OUR adapter + tool
 * pipeline: a fresh conversation with a restricted toolset (everything except
 * the Task tool, so children can't recurse), run to completion, and the final
 * assistant text is returned as the child's report to the parent.
 *
 * Children run in bypassPermissions mode — they have no UI to prompt, matching
 * the upstream CLI's sub-agent behavior.
 */

import { getProviderManager } from "../provider/manager.js";
import { resolveModelOn } from "../provider/types.js";
import { createAdapter } from "../llm/adapter.js";
import type { LLMContentBlock, LLMMessage } from "../llm/adapter.js";
import type { AgentDefinition } from "./agent-defs.js";
import { getSubAgentPrompt } from "./prompts-vendor.js";
import { cavemanDirective, isCaveman } from "./caveman.js";
import { executeVendorTool, getVendorApiTools } from "./vendor-tools.js";
import { runWithCwdOverride } from "@vendor/utils/cwd.js";

const SUBAGENT_MAX_TURNS = 20;

/** Structured progress a sub-agent reports to the UI (via the Task tool).
 * `start`/`done` are emitted by the Task tool around the run; `text`/`tool`/
 * `tool_done` are emitted by runSubAgent as the child works. */
export type SubAgentUpdate =
  | {
      kind: "start";
      agentType: string;
      description?: string;
      background?: boolean;
    }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown> }
  | {
      kind: "tool_done";
      id: string;
      name: string;
      output: string;
      isError?: boolean;
    }
  | { kind: "done" };

type SubAgentOptions = {
  prompt: string;
  model: string;
  /** The resolved agent type: system prompt, tool filter, model/effort. */
  def?: AgentDefinition;
  signal?: AbortSignal;
  /** Live progress channel — text deltas and child tool calls. */
  emit?: (update: SubAgentUpdate) => void;
  /** The parent's resolved workspace, passed explicitly to the child run. */
  cwd: string;
  /** Team addressing: the PARENT chat's id and this agent's member name, so
   * messages sent to it can be delivered between turns. */
  teamSessionId?: string;
  memberName?: string;
};

export function runSubAgent(opts: SubAgentOptions): Promise<string> {
  return runWithCwdOverride(opts.cwd, () => runSubAgentWithCwd(opts));
}

async function runSubAgentWithCwd(opts: SubAgentOptions): Promise<string> {
  const { prompt, def, signal, emit, cwd } = opts;

  // The definition may override the model — but only if it still exists on the
  // active provider. A removed/renamed model falls back to the chat's model.
  //
  // Resolved WITH that override, not just renamed to it. Swapping the name
  // while keeping the chat model's numbers is how a sub-agent pinned to a
  // small model got the big one's max_tokens, and the reverse.
  const stored = getProviderManager().getActiveProvider();
  if (!stored) return "Sub-agent error: no active provider configured.";
  const known = def?.model && stored.models?.some((m) => m.name === def.model);
  const model = known ? (def!.model as string) : opts.model;
  const provider = resolveModelOn(stored, model);
  if (!provider) return "Sub-agent error: the active provider has no models.";
  const adapter = createAdapter(provider);

  // Restricted toolset: always drop Task/Agent so a child can't spawn its own
  // children (no unbounded nesting). The definition may further narrow it via
  // an allow-list (tools) and/or a deny-list (disallowedTools).
  let tools = (await getVendorApiTools()).filter(
    (t) => t.name !== "Task" && t.name !== "Agent",
  );
  if (def?.tools) {
    const allow = new Set(def.tools);
    tools = tools.filter((t) => allow.has(t.name));
  }
  if (def?.disallowedTools) {
    const deny = new Set(def.disallowedTools);
    tools = tools.filter((t) => !deny.has(t.name));
  }
  // Delegated work inherits the same method and discipline as the main agent —
  // a sub-agent that skips read-before-edit or claims success without running
  // anything does the damage in the parent's name. Caveman applies too: a
  // terse chat should not spawn a chatty child.
  //
  // Imported lazily on purpose: index → vendor-tools → agent-tool → here, so a
  // static import back into index would close that loop (same reason
  // routine-tool defers its scheduler import).
  const { agentMethodPrompt, agentDisciplinePrompt } = await import("./index.js");
  const system = [
    def?.systemPrompt || getSubAgentPrompt(),
    agentMethodPrompt(),
    agentDisciplinePrompt(),
    isCaveman() ? cavemanDirective() : "",
    `# Environment\n- Working directory: ${cwd}`,
  ]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n\n");

  const messages: LLMMessage[] = [{ role: "user", content: prompt }];
  const sessionId = `sub:${Math.random().toString(36).slice(2)}`;
  let finalText = "";

  for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
    if (signal?.aborted) return finalText || "Sub-agent aborted.";

    // Messages addressed to this agent while it was working. Delivered at a
    // turn boundary so a mid-turn arrival can't break the tool_use/tool_result
    // pairing the API requires.
    if (opts.teamSessionId && opts.memberName) {
      const { drainInbox } = await import("./bg-agents.js");
      const inbox = drainInbox(opts.teamSessionId, opts.memberName);
      if (inbox.length > 0)
        messages.push({
          role: "user",
          content: `<system-reminder>\nMessages for you:\n\n${inbox.join("\n\n")}\n</system-reminder>`,
        });
    }

    let assistantText = "";
    const toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    try {
      await adapter.stream(
        {
          model,
          system,
          messages,
          tools,
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
          effort: def?.effort,
        },
        (event) => {
          if (event.type === "text_delta") {
            assistantText += event.text;
            emit?.({ kind: "text", text: event.text });
          }
          if (event.type === "tool_use")
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
        },
        signal,
      );
    } catch (err) {
      return (
        finalText +
        `\nSub-agent stream error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const blocks: LLMContentBlock[] = [];
    if (assistantText) blocks.push({ type: "text", text: assistantText });
    for (const tc of toolCalls)
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    if (blocks.length)
      messages.push({
        role: "assistant",
        content:
          assistantText && toolCalls.length === 0 ? assistantText : blocks,
      });

    if (toolCalls.length === 0) {
      finalText = assistantText;
      break;
    }

    const results: {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) return finalText || "Sub-agent aborted.";
      emit?.({ kind: "tool", id: tc.id, name: tc.name, input: tc.input });
      const r = await executeVendorTool({
        sessionId,
        toolUseID: tc.id,
        name: tc.name,
        input: tc.input,
        model,
        permissionMode: "bypassPermissions",
        signal,
        // Plan updates from this child carry its name, not a generic "agent".
        agentLabel: opts.memberName ?? opts.def?.type,
      });
      emit?.({
        kind: "tool_done",
        id: tc.id,
        name: tc.name,
        output: r.content,
        isError: r.isError,
      });
      results.push({
        tool_use_id: tc.id,
        content: r.content,
        is_error: r.isError || undefined,
      });
    }
    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    });
  }

  return finalText || "(sub-agent produced no output)";
}

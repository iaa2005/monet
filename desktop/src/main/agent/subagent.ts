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
 * Claude Code sub-agent behavior.
 */

import { getProviderManager } from "../provider/manager.js";
import { createAdapter } from "../llm/adapter.js";
import type { LLMContentBlock, LLMMessage } from "../llm/adapter.js";
import { getSubAgentPrompt } from "./prompts-vendor.js";
import { executeVendorTool, getVendorApiTools } from "./vendor-tools.js";

const SUBAGENT_MAX_TURNS = 20;

export async function runSubAgent(opts: {
  prompt: string;
  model: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<string> {
  const { prompt, model, signal, onProgress } = opts;

  const provider = getProviderManager().getActive();
  if (!provider) return "Sub-agent error: no active provider configured.";
  const adapter = createAdapter(provider);

  // Restricted toolset: drop the Task tool so a child can't spawn its own
  // children (no unbounded nesting). MCP + everything else stays available.
  const tools = (await getVendorApiTools()).filter((t) => t.name !== "Task");
  const system = getSubAgentPrompt();

  const messages: LLMMessage[] = [{ role: "user", content: prompt }];
  const sessionId = `sub:${Math.random().toString(36).slice(2)}`;
  let finalText = "";

  for (let turn = 0; turn < SUBAGENT_MAX_TURNS; turn++) {
    if (signal?.aborted) return finalText || "Sub-agent aborted.";

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
        },
        (event) => {
          if (event.type === "text_delta") {
            assistantText += event.text;
            onProgress?.(event.text);
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
      onProgress?.(`\n⚙ Sub-agent: running ${tc.name}...\n`);
      const r = await executeVendorTool({
        sessionId,
        toolUseID: tc.id,
        name: tc.name,
        input: tc.input,
        model,
        permissionMode: "bypassPermissions",
        signal,
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

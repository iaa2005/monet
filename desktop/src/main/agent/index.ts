/**
 * Agent loop — drives the REAL vendor (leaked Claude Code) tools through the
 * provider-agnostic LLM adapter layer.
 *
 * Tools, schemas, per-tool prompts, validation and permission checks all come
 * from vendor/leaked (see agent/vendor-tools.ts). The transport stays ours:
 * the adapter speaks Anthropic/OpenAI/DeepSeek and streams LLMEvents to the
 * renderer, so the UI is untouched.
 */

import type {
  LLMEvent,
  LLMMessage,
  LLMContentBlock,
  LLMUsage,
} from "../llm/adapter.js";
import { getProviderManager } from "../provider/manager.js";
import { createAdapter } from "../llm/adapter.js";
import { getSystemPrompt as getFallbackSystemPrompt } from "./prompts-vendor.js";
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorTools,
  clearSessionGrants,
  type RequestPermission,
  type UiPermissionMode,
} from "./vendor-tools.js";
import { dropSessionContext, initVendorRuntime } from "./vendor-context.js";
import { shouldCompact, compactMessages } from "./compaction.js";

// ─── System prompt ──────────────────────────────────────────────────────

/**
 * The real Claude Code system prompt (git/env-aware, CLAUDE.md/MEMORY.md,
 * per-tool guidance). Falls back to the local facade if the vendor prompt
 * builder trips over a CLI-only dependency at runtime.
 */
async function buildSystemPrompt(model: string): Promise<string> {
  initVendorRuntime();
  try {
    const { getSystemPrompt } = await import(
      "@vendor/constants/prompts.js"
    );
    const sections = await getSystemPrompt(getVendorTools(), model);
    const prompt = sections.filter(Boolean).join("\n\n");
    if (prompt.trim().length > 0) return prompt;
    throw new Error("vendor system prompt came back empty");
  } catch (err) {
    console.warn(
      "[agent] vendor getSystemPrompt failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    return getFallbackSystemPrompt();
  }
}

// ─── Agent loop ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  maxTurns?: number;
  signal?: AbortSignal;
  /** Prepended to the system prompt (used by chat modes like Plan/Concise). */
  modeDirective?: string;
  /** Permission level driving the tool gate (default: "default" = ask). */
  permissionMode?: UiPermissionMode;
  /** Called when a tool needs the user's approval (routes to the UI dialog). */
  requestPermission?: RequestPermission;
}

/**
 * Per-session conversation history kept in the proper multi-turn format
 * (assistant text + tool_use blocks, user tool_result blocks). This is what
 * makes the chat multi-turn: each send continues the same array.
 */
const conversations = new Map<string, LLMMessage[]>();

/** Drop a session's in-memory history (e.g. on "New session"). */
export function resetConversation(sessionId: string): void {
  conversations.delete(sessionId);
  dropSessionContext(sessionId);
  clearSessionGrants(sessionId);
}

/**
 * Seed a session's history from previously persisted display messages so a
 * reopened chat can continue (text-only reconstruction of past turns).
 */
export function seedConversation(
  sessionId: string,
  priorText: { role: "user" | "assistant"; content: string }[],
): void {
  if (conversations.has(sessionId)) return;
  conversations.set(
    sessionId,
    priorText.filter((m) => m.content).map((m) => ({ ...m })),
  );
}

export async function runAgent(
  sessionId: string,
  userContent: string | LLMContentBlock[],
  onEvent: (event: LLMEvent) => void,
  options: AgentRunOptions = {},
): Promise<void> {
  const provider = getProviderManager().getActive();
  if (!provider) {
    onEvent({
      type: "error",
      error: "No active provider configured. Go to Settings to add one.",
    });
    return;
  }

  const adapter = createAdapter(provider);
  const {
    maxTurns = 40,
    signal,
    modeDirective,
    permissionMode = "default",
    requestPermission,
  } = options;

  let tools;
  let basePrompt;
  try {
    [tools, basePrompt] = await Promise.all([
      getVendorApiTools(),
      buildSystemPrompt(provider.model),
    ]);
  } catch (err) {
    onEvent({
      type: "error",
      error: `Agent init failed: ${err instanceof Error ? err.message : err}`,
    });
    onEvent({ type: "message_stop", stop_reason: "error" });
    return;
  }

  const systemPrompt = modeDirective
    ? `${modeDirective}\n\n${basePrompt}`
    : basePrompt;

  let messages = conversations.get(sessionId);
  if (!messages) {
    messages = [];
    conversations.set(sessionId, messages);
  }
  messages.push({ role: "user", content: userContent });

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      onEvent({ type: "error", error: "Aborted" });
      onEvent({ type: "message_stop", stop_reason: "abort" });
      return;
    }

    // Auto-compaction: if the running history would overflow the context
    // window, summarize it and continue from the summary. Best-effort — on
    // failure compactMessages() returns the history unchanged. Mutate in
    // place so the per-session conversations Map keeps the same array ref.
    if (shouldCompact(messages)) {
      const compacted = await compactMessages({
        messages,
        adapter,
        model: provider.model,
        maxTokens: provider.maxTokens || 16000,
        signal,
      });
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
      }
    }

    const toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let assistantText = "";
    let streamError: string | null = null;
    let lastUsage: LLMUsage | undefined;

    try {
      await adapter.stream(
        {
          model: provider.model,
          system: systemPrompt,
          messages,
          tools,
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
        },
        (event) => {
          if (event.type === "text_delta") assistantText += event.text;
          if (event.type === "tool_use")
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input,
            });
          if (event.type === "error") streamError = event.error;
          // Suppress the PER-TURN message_stop: in an agentic run each tool-use
          // turn's stream ends with a message_stop, but the task isn't done —
          // forwarding it would flip the UI to "finished" between turns (spinner
          // vanishes while tools run). The loop emits ONE authoritative
          // message_stop when the task truly ends (no tool calls / error /
          // abort). Keep the usage from the latest turn for that final event.
          if (event.type === "message_stop") {
            lastUsage = event.usage;
            return;
          }
          onEvent(event);
        },
        signal,
      );
    } catch (err) {
      streamError = err instanceof Error ? err.message : "Stream error";
      onEvent({ type: "error", error: streamError });
      // Stream crashed — tell frontend we're done.
      onEvent({ type: "message_stop", stop_reason: "error" });
      return;
    }

    // Record the assistant turn (text + tool_use blocks) so the next turn
    // and the next user message have the full context.
    const assistantBlocks: LLMContentBlock[] = [];
    if (assistantText)
      assistantBlocks.push({ type: "text", text: assistantText });
    for (const tc of toolCalls)
      assistantBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    if (assistantBlocks.length > 0)
      messages.push({
        role: "assistant",
        content:
          assistantText && toolCalls.length === 0
            ? assistantText
            : assistantBlocks,
      });

    if (toolCalls.length === 0) {
      onEvent({ type: "message_stop", stop_reason: "end_turn", usage: lastUsage });
      return;
    }

    // Execute tools through the vendor pipeline with progress events.
    const results: {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) {
        onEvent({ type: "error", error: "Aborted" });
        onEvent({ type: "message_stop", stop_reason: "abort" });
        return;
      }
      onEvent({
        type: "tool_result",
        toolUseID: tc.id,
        toolName: tc.name,
        content: "Running...",
      });
      const result = await executeVendorTool({
        sessionId,
        toolUseID: tc.id,
        name: tc.name,
        input: tc.input,
        model: provider.model,
        permissionMode,
        requestPermission,
        signal,
      });
      onEvent({
        type: "tool_result",
        toolUseID: tc.id,
        toolName: tc.name,
        content: result.content,
      });
      results.push({
        tool_use_id: tc.id,
        content: result.content,
        is_error: result.isError || undefined,
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
}

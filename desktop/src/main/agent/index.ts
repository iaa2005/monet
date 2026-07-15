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
import type { EffortLevel } from "../provider/types.js";
import { createAdapter } from "../llm/adapter.js";
import { getSystemPrompt as getFallbackSystemPrompt } from "./prompts-vendor.js";
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorTools,
  getVendorToolsForSpace,
  clearSessionGrants,
  type RequestPermission,
  type UiPermissionMode,
} from "./vendor-tools.js";
import { dropSessionContext, initVendorRuntime } from "./vendor-context.js";
import { drainBgResults } from "./bg-agents.js";
import { buildMemoryPrompt } from "../memory/store.js";
import { getProfilePrompt } from "../profile.js";
import { tunablePrompt } from "../prompts/index.js";
import type { AskUserFn } from "../ipc/ask-user.js";

/** Prepend finished background-agent reports to the user turn as context. */
function mergeBackgroundResults(
  notes: string[],
  content: string | LLMContentBlock[],
): string | LLMContentBlock[] {
  const prefix = notes.join("\n\n") + "\n\n";
  if (typeof content === "string") return prefix + content;
  return [{ type: "text", text: prefix }, ...content];
}
import {
  shouldCompact,
  compactMessages,
  compactionThreshold,
  estimateTokens,
} from "./compaction.js";

// ─── System prompt ──────────────────────────────────────────────────────

/**
 * The real Claude Code system prompt (git/env-aware, CLAUDE.md/MEMORY.md,
 * per-tool guidance). Falls back to the local facade if the vendor prompt
 * builder trips over a CLI-only dependency at runtime.
 */
async function buildSystemPrompt(
  model: string,
  space?: string,
): Promise<string> {
  initVendorRuntime();
  try {
    const { getSystemPrompt } = await import("@vendor/constants/prompts.js");
    // Space-filtered: in Home the prompt must not even MENTION Bash/FileEdit —
    // a model that reads about a tool will try to call it.
    const sections = await getSystemPrompt(getVendorToolsForSpace(space), model);
    const prompt = sections.filter(Boolean).join("\n\n");
    if (prompt.trim().length > 0) return withUserMemory(prompt);
    throw new Error("vendor system prompt came back empty");
  } catch (err) {
    console.warn(
      "[agent] vendor getSystemPrompt failed, using fallback:",
      err instanceof Error ? err.message : err,
    );
    return withUserMemory(await getFallbackSystemPrompt());
  }
}

/** Append the user's long-term memory files (Settings → Memory) to the prompt. */
function withUserMemory(prompt: string): string {
  try {
    const extra = [getProfilePrompt(), buildMemoryPrompt()].filter(Boolean);
    return extra.length ? `${prompt}\n\n${extra.join("\n\n")}` : prompt;
  } catch {
    return prompt;
  }
}

/** Plain-text tail of a session's conversation (for memory extraction):
 * user/assistant text only, tool blocks reduced to one-line markers. */
export function getConversationText(
  sessionId: string,
  maxChars = 8_000,
): string | null {
  const messages = conversations.get(sessionId);
  if (!messages || messages.length === 0) return null;
  const lines: string[] = [];
  for (const m of messages.slice(-14)) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    const chunks: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") chunks.push(b.text);
      else if (b.type === "tool_use") chunks.push(`[tool: ${b.name}]`);
      else if (b.type === "tool_result") chunks.push(`[tool result]`);
    }
    if (chunks.length) lines.push(`${m.role}: ${chunks.join(" ")}`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Prepended in Home so the model knows the ground rules of the space.
 * Tunable via <dataDir>/prompts/home-directive.md. */
const HOME_DIRECTIVE_DEFAULT = [
  "You are in HOME. Your default workspace is an ISOLATED sandbox — you have",
  "no direct access to the user's filesystem or shell. This chat has its OWN",
  "sandbox of files (user attachments + files you produce): SandboxList",
  "shows them (subfolders included), SandboxRead/SandboxWrite handle text files,",
  "and RunPython executes Python in the same directory — use it for computation,",
  "data analysis and binary documents (charts, docx, xlsx). Every file written",
  "there is attached to the conversation automatically. Only the tools",
  "explicitly provided to you (e.g. Browser or Computer Use, if enabled) reach",
  "outside this sandbox — do not assume any other system access.",
].join(" ");
const homeDirective = (): string =>
  tunablePrompt("home-directive", HOME_DIRECTIVE_DEFAULT);

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
  /** Round-trips an AskUserQuestion to the renderer dialog. */
  askUser?: AskUserFn;
  /** Workspace ("home" | "code") — selects the advertised toolset. */
  space?: string;
  /** Reasoning effort requested from the composer (absent = provider default). */
  effort?: EffortLevel;
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

/**
 * Compact a session's in-memory history on demand (e.g. before switching to a
 * model with a smaller context window). Returns the token estimates, or null
 * when there's nothing to compact / no provider.
 */
export async function compactSessionNow(
  sessionId: string,
): Promise<{ before: number; after: number } | null> {
  const messages = conversations.get(sessionId);
  if (!messages || messages.length < 2) return null;
  const provider = getProviderManager().getActive();
  if (!provider) return null;
  const adapter = createAdapter(provider);
  const before = estimateTokens(messages);
  const compacted = await compactMessages({
    messages,
    adapter,
    model: provider.model,
    maxTokens: provider.maxTokens || 16000,
  });
  if (compacted !== messages) {
    messages.length = 0;
    messages.push(...compacted);
  }
  return { before, after: estimateTokens(messages) };
}

/** Rough input-token estimate of a session's in-memory history. */
export function estimateSessionTokens(sessionId: string): number {
  const messages = conversations.get(sessionId);
  return messages ? estimateTokens(messages) : 0;
}

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
  /** Optional drill-down: the individual entries that make up this category
   * (e.g. each tool, each MCP server, each skill). Estimated like the parent. */
  items?: { label: string; tokens: number }[];
}
export interface ContextBreakdown {
  budget: number;
  used: number;
  free: number;
  categories: ContextCategory[];
  /** Actual token usage from the last API response for this session, when the
   * agent has run at least one turn in this process. Null for cold/old chats.
   * When present, `used` is measured (not estimated). */
  apiUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  } | null;
}

/** Last API usage seen per session, captured from message_stop in runAgent.
 * Lets computeContextBreakdown report the REAL context total (input + cache)
 * instead of a chars/4 estimate once a turn has completed. Process-lived. */
const lastUsageBySession = new Map<string, LLMUsage>();

/**
 * Estimate what currently fills the model's context window, by category — the
 * same pieces runAgent sends (system prompt, tool schemas, conversation). Token
 * counts are rough (chars/4), matching estimateTokens; the point is the mix,
 * not exact accounting. Best-effort: a partial breakdown still renders.
 */
export async function computeContextBreakdown(
  sessionId: string,
  space?: string,
  messageTokensOverride?: number,
): Promise<ContextBreakdown> {
  const provider = getProviderManager().getActive();
  const budget = provider?.inputLimit ?? provider?.contextLimit ?? 200_000;
  // Prefer the renderer's estimate (it always has the visible history, even for
  // old chats never run in this process); fall back to the in-memory run.
  const messageTokens =
    messageTokensOverride ?? estimateTokens(conversations.get(sessionId) ?? []);

  let systemTokens = 0;
  let toolTokens = 0;
  let mcpToolTokens = 0;
  let skillTokens = 0;
  let memoryTokens = 0;
  // Per-item drill-down (each tool, each MCP server, each skill, each memory src).
  const toolItems: { label: string; tokens: number }[] = [];
  const mcpByServer = new Map<string, number>();
  let skillItems: { label: string; tokens: number }[] = [];
  let memoryItems: { label: string; tokens: number }[] = [];
  try {
    const [apiTools, basePrompt] = await Promise.all([
      getVendorApiTools(space),
      provider ? buildSystemPrompt(provider.model, space) : Promise.resolve(""),
    ]);
    const directives = space === "home" ? [homeDirective()] : [];
    const systemPrompt = [...directives, basePrompt]
      .filter(Boolean)
      .join("\n\n");
    const systemTotal = Math.ceil(systemPrompt.length / 4);

    for (const t of apiTools) {
      const size = Math.ceil(JSON.stringify(t).length / 4);
      if (t.name.startsWith("mcp__")) {
        mcpToolTokens += size;
        // mcp__<server>__<tool> → group by server for the drill-down.
        const server = t.name.split("__")[1] || "mcp";
        mcpByServer.set(server, (mcpByServer.get(server) ?? 0) + size);
      } else {
        toolTokens += size;
        toolItems.push({ label: t.name, tokens: size });
      }
    }

    // Skills (the Skill tool's catalog) and memory (CLAUDE.md) both live INSIDE
    // the system prompt, so estimate each and carve them out of it — this keeps
    // the categories mutually exclusive and the total honest.
    try {
      const { listSkillInfos } = await import("../ipc/skills.js");
      skillItems = listSkillInfos().map((s) => ({
        label: s.name,
        tokens: Math.ceil((s.name.length + s.description.length + 12) / 4),
      }));
      skillTokens = skillItems.reduce((n, s) => n + s.tokens, 0);
    } catch {
      /* ignore */
    }
    // "Memory files" isn't just CLAUDE.md — it's every long-term-context block
    // withUserMemory() folds into basePrompt: the user Profile, the Settings →
    // Memory facts, and (Code only) the workspace CLAUDE.md. All three live
    // inside systemTotal, so carving them out here keeps System vs Memory honest
    // AND makes the popover show WHAT memory is made of instead of a flat 0.
    try {
      const { loadClaudeMd } = await import("../claude-md.js");
      const { getWorkspacePath } = await import("../ipc/workspace.js");
      const md = space === "home" ? null : loadClaudeMd(getWorkspacePath());
      const tok = (s: string | null): number => (s ? Math.ceil(s.length / 4) : 0);
      memoryItems = [
        { label: "Profile", tokens: tok(getProfilePrompt()) },
        { label: "User memory", tokens: tok(buildMemoryPrompt()) },
        { label: "CLAUDE.md", tokens: tok(md) },
      ].filter((i) => i.tokens > 0);
      memoryTokens = memoryItems.reduce((n, i) => n + i.tokens, 0);
    } catch {
      /* ignore */
    }
    skillTokens = Math.min(skillTokens, systemTotal);
    memoryTokens = Math.min(memoryTokens, systemTotal - skillTokens);
    systemTokens = systemTotal - skillTokens - memoryTokens;
  } catch {
    /* best-effort */
  }

  const estimatedSum =
    messageTokens +
    systemTokens +
    toolTokens +
    mcpToolTokens +
    skillTokens +
    memoryTokens;

  // Real usage (input + cache) once a turn has run this process; else estimate.
  const usage = lastUsageBySession.get(sessionId);
  const apiUsed = usage
    ? usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    : undefined;
  // The measured total usually exceeds our chars/4 estimate (exact tokenizer,
  // tool preamble, cache framing). Surface that gap as its own line so the
  // categories still sum to `used` and the bar stays consistent.
  const overhead = apiUsed != null ? Math.max(0, apiUsed - estimatedSum) : 0;
  const used = estimatedSum + overhead;
  const free = Math.max(0, budget - used);

  const sortItems = (
    xs: { label: string; tokens: number }[],
  ): { label: string; tokens: number }[] =>
    xs.filter((x) => x.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  const mcpItems = sortItems(
    [...mcpByServer].map(([label, tokens]) => ({ label, tokens })),
  );

  const categories: ContextCategory[] = [
    { key: "messages", label: "Messages", tokens: messageTokens },
    { key: "system", label: "System prompt", tokens: systemTokens },
    {
      key: "tools",
      label: "System tools",
      tokens: toolTokens,
      items: sortItems(toolItems),
    },
    {
      key: "mcp",
      label: "MCP tools",
      tokens: mcpToolTokens,
      items: mcpItems,
    },
    {
      key: "skills",
      label: "Skills",
      tokens: skillTokens,
      items: sortItems(skillItems),
    },
    {
      key: "memory",
      label: "Memory files",
      tokens: memoryTokens,
      items: sortItems(memoryItems),
    },
    ...(overhead > 0
      ? [{ key: "overhead", label: "Measured overhead", tokens: overhead }]
      : []),
    { key: "free", label: "Free space", tokens: free },
  ];
  return {
    budget,
    used,
    free,
    categories,
    apiUsage: usage
      ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        }
      : null,
  };
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
    askUser,
    space,
    effort,
  } = options;

  let tools;
  let basePrompt;
  try {
    [tools, basePrompt] = await Promise.all([
      getVendorApiTools(space),
      buildSystemPrompt(provider.model, space),
    ]);
  } catch (err) {
    onEvent({
      type: "error",
      error: `Agent init failed: ${err instanceof Error ? err.message : err}`,
    });
    onEvent({ type: "message_stop", stop_reason: "error" });
    return;
  }

  const directives = [
    ...(space === "home" ? [homeDirective()] : []),
    ...(modeDirective ? [modeDirective] : []),
  ];
  const systemPrompt =
    directives.length > 0
      ? `${directives.join("\n\n")}\n\n${basePrompt}`
      : basePrompt;

  let messages = conversations.get(sessionId);
  if (!messages) {
    messages = [];
    conversations.set(sessionId, messages);
  }
  // Fold any finished background sub-agent reports into this user turn so the
  // model can act on them. Done at the turn boundary (not when they finish) to
  // keep user/assistant alternation intact.
  const bgResults = drainBgResults(sessionId);
  const turnContent =
    bgResults.length > 0
      ? mergeBackgroundResults(bgResults, userContent)
      : userContent;
  messages.push({ role: "user", content: turnContent });

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
    // Budget comes from the active model: max input tokens if set, else its
    // context length (resolved by the provider manager).
    if (
      shouldCompact(
        messages,
        compactionThreshold(provider.inputLimit ?? provider.contextLimit),
      )
    ) {
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
    let lastStopReason: string | undefined;

    try {
      await adapter.stream(
        {
          model: provider.model,
          system: systemPrompt,
          messages,
          tools,
          max_tokens: provider.maxTokens || 16000,
          temperature: provider.temperature,
          effort: provider.supportsEffort ? effort : undefined,
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
            lastStopReason = event.stop_reason;
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

    // Remember this turn's real token usage so the context meter can report the
    // measured total (input + cache) instead of a chars/4 estimate.
    if (lastUsage) lastUsageBySession.set(sessionId, lastUsage);

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
      onEvent({
        type: "message_stop",
        // Propagate the turn's real stop_reason (message_delta): the renderer
        // flags max_tokens so a silently truncated reply is visible.
        stop_reason: lastStopReason ?? "end_turn",
        usage: lastUsage,
      });
      // Code Rewind: snapshot the workspace AFTER the reply is done (never
      // blocks it) so this turn can be restored later. Home has no workspace.
      if (space && space !== "home") {
        try {
          const { getWorkspacePath } = await import("../ipc/workspace.js");
          const { snapshotWorkspace } = await import("./checkpoints.js");
          const sha = await snapshotWorkspace(sessionId, getWorkspacePath());
          if (sha) onEvent({ type: "checkpoint", sha });
        } catch {
          /* best-effort */
        }
      }
      return;
    }

    // Execute tools through the vendor pipeline with progress events.
    const results: {
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      image?: { base64: string; mediaType: string };
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
        askUser,
        signal,
        space,
        onProgress: (text) => {
          onEvent({
            type: "tool_result",
            toolUseID: tc.id,
            toolName: tc.name,
            content: text,
          });
        },
        onSubAgentEvent: (u) => {
          onEvent({
            type: "subagent",
            toolUseID: tc.id,
            kind: u.kind,
            agentType: u.kind === "start" ? u.agentType : undefined,
            description: u.kind === "start" ? u.description : undefined,
            background: u.kind === "start" ? u.background : undefined,
            text: u.kind === "text" ? u.text : undefined,
            childId:
              u.kind === "tool" || u.kind === "tool_done" ? u.id : undefined,
            name:
              u.kind === "tool" || u.kind === "tool_done" ? u.name : undefined,
            input: u.kind === "tool" ? u.input : undefined,
            output: u.kind === "tool_done" ? u.output : undefined,
            isError: u.kind === "tool_done" ? u.isError : undefined,
          });
        },
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
        image: result.image,
      });
    }

    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        // A screenshot is attached as an image block so the model can see it.
        content: r.image
          ? [
              { type: "text" as const, text: r.content },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: r.image.mediaType,
                  data: r.image.base64,
                },
              },
            ]
          : r.content,
        is_error: r.is_error,
      })),
    });
  }

  // Loop fell through maxTurns without a natural end (no more tool calls) —
  // emit the terminal message_stop anyway so the UI doesn't stay stuck
  // "streaming" forever.
  onEvent({ type: "message_stop", stop_reason: "max_turns" });
}

import type { OpenRouterRouting } from "../provider/types.js";
import type { EffortLevel, LLMProvider } from "../provider/types.js";
import { AnthropicClient } from "./anthropic-client.js";
import { OpenAICompatClient } from "./openai-compat-client.js";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      /** Audio clip (models with the audio modality; OpenAI input_audio). */
      type: "audio";
      source: { type: "base64"; media_type: string; data: string };
      name?: string;
    }
  | {
      /** Document, e.g. PDF (Anthropic document block / OpenAI file part). */
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
      name?: string;
    }
  | {
      /** Video clip (passed as a file part to providers that accept it). */
      type: "video";
      source: { type: "base64"; media_type: string; data: string };
      name?: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      /** Text, or a block array (text + image) — Computer Use returns a
       * screenshot the model must SEE. */
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | {
                type: "image";
                source: { type: "base64"; media_type: string; data: string };
              }
          >;
      is_error?: boolean;
    };

export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  max_tokens: number;
  temperature?: number;
  /** Reasoning effort to request (maps to thinking budget / reasoning_effort).
   * Absent = provider default (no reasoning param sent). */
  effort?: EffortLevel;
  /** OpenRouter: provider routing preferences. */
  routing?: OpenRouterRouting;
}

/** Ensure max_tokens is a positive finite number. No hard cap — models like
 * GLM-5.2 support 130K+ output tokens, and capping at 64K silently truncated
 * long replies mid-sentence. The provider's maxOutputTokens is the source of
 * truth; the caller (resolveProvider) sets the right value per model. */
export function sanitizeMaxTokens(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n <= 0) return 16000;
  return Math.floor(n);
}

export type LLMEvent =
  | { type: "text_delta"; text: string }
  // Extended-thinking / reasoning tokens. Display-only — the agent loop
  // forwards these to the UI but never adds them to the model context.
  | { type: "reasoning_delta"; text: string }
  | {
      type: "user_message";
      content: string;
      /** Handed to a turn already in flight (Ctrl+S) rather than sent as a
       * prompt. The chat draws it as a user message but must not count it as
       * one — see ChatMessage.injected in the renderer's types. */
      injected?: boolean;
    }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "message_stop";
      stop_reason: string;
      usage?: LLMUsage;
      /**
       * The run ended with a reply that had no text and no tool calls. The
       * only trace such a turn leaves — nothing reaches the transcript —
       * so it is what tells a post-mortem apart: "end_turn" with nothing in
       * it is a model that gave up, "max_tokens" with nothing in it is a
       * reasoning budget that ate the answer.
       */
      empty?: boolean;
      /**
       * OpenRouter only: the company that actually served this reply, as the
       * response's top-level `provider` field reports it ("Novita", "Baidu",
       * "OpenAI"). The one way to check that a provider pin took effect —
       * `service_tier` comes back null even when honoured.
       */
      servedBy?: string;
    }
  | { type: "error"; error: string }
  | { type: "checkpoint"; sha: string }
  // The harness overrode or redirected the model — a nudge after an empty
  // reply, a loop correction, a budget note. One event per intervention so
  // the transcript can say it happened; without this, the extra turn the
  // harness spent is indistinguishable from the model acting on its own.
  | { type: "harness"; text: string }
  // Goal mode: the state of the session's standing objective, emitted on every
  // change so the UI strip follows a run it did not start.
  | {
      type: "goal";
      status: "active" | "paused" | "blocked" | "complete";
      objective: string;
      turns: number;
      maxTurns: number;
      tokens: number;
      maxTokens?: number;
      /** Why it stopped, when it did. */
      detail?: string;
    }
  // The verification loop: the harness running the project's own checks after
  // a turn that edited files, and fixing what they find (see verify/loop.ts).
  | {
      type: "verify";
      phase: "checking" | "fixing" | "clean" | "fixed" | "gave-up" | "known-red";
      /** Fix turns taken so far. */
      attempt: number;
      maxAttempts: number;
      /** The failing check's name, when there is one. */
      check?: string;
      detail?: string;
    }
  | {
      type: "tool_result";
      toolUseID: string;
      toolName: string;
      content: string;
      /**
       * The call actually finished, as opposed to starting or reporting
       * progress — all three arrive as this event with the content of the
       * moment. Anything that CLOSES a row must wait for this one, or it
       * records the placeholder as the result: done in 0s, output "Running…".
       */
      final?: boolean;
    }
  // Live progress of a sub-agent launched by the Task tool, keyed to the
  // launching tool_use so the UI can render a nested "agent card".
  | {
      type: "subagent";
      toolUseID: string;
      kind: "start" | "text" | "tool" | "tool_done" | "done";
      agentType?: string;
      description?: string;
      /** Whether this sub-agent runs detached in the background. */
      background?: boolean;
      text?: string;
      /** Child tool call id (kind "tool" / "tool_done"). */
      childId?: string;
      /** Child tool name (kind "tool" / "tool_done"). */
      name?: string;
      input?: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    };

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface LLMAdapter {
  readonly providerId: string;
  readonly providerName: string;
  stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMMessage>;
}

export function createAdapter(provider: LLMProvider): LLMAdapter {
  switch (provider.kind) {
    case "anthropic":
    case "deepseek":
      return new AnthropicClient(provider);
    case "openai":
    case "openrouter":
      return new OpenAICompatClient(provider);
    default:
      throw new Error(`Unknown provider kind: ${provider.kind}`);
  }
}

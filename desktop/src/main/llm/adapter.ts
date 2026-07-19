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
  | { type: "user_message"; content: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "message_stop"; stop_reason: string; usage?: LLMUsage }
  | { type: "error"; error: string }
  | { type: "checkpoint"; sha: string }
  | {
      type: "tool_result";
      toolUseID: string;
      toolName: string;
      content: string;
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

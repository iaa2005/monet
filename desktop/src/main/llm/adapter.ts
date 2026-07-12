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

/** Highest max_tokens we ever send to a provider. max_tokens is an OUTPUT
 * limit — if a context-window size (e.g. 380000) gets pasted into the
 * provider settings, some proxies silently ignore the invalid value and fall
 * back to a tiny default, which truncates long replies mid-sentence. */
export const MAX_OUTPUT_TOKENS = 64000;

export function sanitizeMaxTokens(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n <= 0) return 16000;
  return Math.min(Math.floor(n), MAX_OUTPUT_TOKENS);
}

export type LLMEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "message_stop"; stop_reason: string; usage?: LLMUsage }
  | { type: "error"; error: string }
  | {
      type: "tool_result";
      toolUseID: string;
      toolName: string;
      content: string;
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

import type { LLMProvider } from "../provider/types.js";
import { AnthropicClient } from "./anthropic-client.js";
import { OpenAIClient } from "./openai-client.js";

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
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
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
  | { type: "error"; error: string };

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
      return new OpenAIClient(provider);
    default:
      throw new Error(`Unknown provider kind: ${provider.kind}`);
  }
}

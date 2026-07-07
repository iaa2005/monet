/**
 * LLM Adapter interface and types.
 *
 * Unified interface for all LLM providers.
 * Each provider gets its own implementation.
 */

import type { LLMProvider } from '../provider/types.js'

// ─── Request / Response types ───────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | LLMContentBlock[]
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface LLMTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface LLMRequest {
  model: string
  system: string
  messages: LLMMessage[]
  tools?: LLMTool[]
  max_tokens: number
  temperature?: number
}

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stop_reason: string; usage?: LLMUsage }
  | { type: 'error'; error: string }

export interface LLMUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// ─── Adapter interface ──────────────────────────────────────────────────

export interface LLMAdapter {
  readonly providerId: string
  readonly providerName: string

  /** Stream a completion, yielding events via callback. Returns abort controller. */
  stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>

  /** Non-streaming completion. */
  complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMMessage>
}

// ─── Factory ────────────────────────────────────────────────────────────

export function createAdapter(provider: LLMProvider): LLMAdapter {
  switch (provider.kind) {
    case 'anthropic':
    case 'deepseek': {
      // DeepSeek uses Anthropic-compatible Messages API
      const { AnthropicClient } = require('./anthropic-client.js') as typeof import('./anthropic-client.js')
      return new AnthropicClient(provider)
    }
    case 'openai': {
      const { OpenAIClient } = require('./openai-client.js') as typeof import('./openai-client.js')
      return new OpenAIClient(provider)
    }
    default:
      throw new Error(`Unknown provider kind: ${(provider as LLMProvider).kind}`)
  }
}

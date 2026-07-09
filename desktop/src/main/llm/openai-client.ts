/**
 * OpenAI-compatible client (llama.cpp, local models, etc.).
 *
 * Uses @ai-sdk/openai for streaming and tool call support.
 * Converts Anthropic-style tools to OpenAI function format.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import type { LLMProvider } from '../provider/types.js'
import type { LLMAdapter, LLMEvent, LLMRequest } from './adapter.js'
import { sanitizeMaxTokens } from './adapter.js'

export class OpenAIClient implements LLMAdapter {
  readonly providerId: string
  readonly providerName: string
  private client: ReturnType<typeof createOpenAI>
  private model: string

  constructor(provider: LLMProvider) {
    this.providerId = provider.id
    this.providerName = provider.name
    this.model = provider.model

    this.client = createOpenAI({
      baseURL: provider.baseURL,
      apiKey: provider.apiKey || 'not-needed',
    })
  }

  async stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = streamText({
        model: this.client(this.model),
        system: request.system,
        messages: request.messages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        maxTokens: sanitizeMaxTokens(request.max_tokens),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        abortSignal: signal,
      })

      for await (const chunk of result.textStream) {
        onEvent({ type: 'text_delta', text: chunk })
      }

      onEvent({
        type: 'message_stop',
        stop_reason: 'stop',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      onEvent({ type: 'error', error: message })
    }
  }

  async complete(
    request: LLMRequest,
    _signal?: AbortSignal,
  ): Promise<{ role: 'assistant'; content: string }> {
    const result = streamText({
      model: this.client(this.model),
      system: request.system,
      messages: request.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      maxTokens: sanitizeMaxTokens(request.max_tokens),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
    })

    let text = ''
    for await (const chunk of result.textStream) {
      text += chunk
    }

    return { role: 'assistant', content: text }
  }
}

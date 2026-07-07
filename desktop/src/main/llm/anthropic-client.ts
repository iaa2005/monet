/**
 * Anthropic Messages API client.
 *
 * Pure HTTP implementation — no @anthropic-ai/sdk dependency.
 * Handles SSE streaming for Anthropic and DeepSeek (Anthropic-compatible).
 */

import type { LLMProvider } from '../provider/types.js'
import type { LLMAdapter, LLMEvent, LLMRequest } from './adapter.js'

interface AnthropicSSEEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
  message?: {
    id: string
    model: string
    usage?: { input_tokens: number; output_tokens: number }
  }
  content_block?: {
    type: string
    id?: string
    name?: string
    index?: number
  }
  delta?: {
    type: string
    text?: string
    partial_json?: string
  }
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: { type: string; message: string }
}

export class AnthropicClient implements LLMAdapter {
  readonly providerId: string
  readonly providerName: string
  private baseURL: string
  private apiKey: string

  constructor(provider: LLMProvider) {
    this.providerId = provider.id
    this.providerName = provider.name
    this.baseURL = provider.baseURL.replace(/\/+$/, '')
    this.apiKey = provider.apiKey
  }

  async stream(
    request: LLMRequest,
    onEvent: (event: LLMEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseURL}/v1/messages`

    // Convert tools to Anthropic format
    const tools = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: true,
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      onEvent({ type: 'error', error: `API ${response.status}: ${errorText}` })
      return
    }

    if (!response.body) {
      onEvent({ type: 'error', error: 'No response body' })
      return
    }

    // Parse SSE stream
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentToolId = ''
    let currentToolName = ''
    let currentToolInput = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const event: AnthropicSSEEvent = JSON.parse(data)

            switch (event.type) {
              case 'content_block_start': {
                if (event.content_block?.type === 'tool_use') {
                  currentToolId = event.content_block.id || ''
                  currentToolName = event.content_block.name || ''
                  currentToolInput = ''
                }
                break
              }
              case 'content_block_delta': {
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                  onEvent({ type: 'text_delta', text: event.delta.text })
                } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                  currentToolInput += event.delta.partial_json
                }
                break
              }
              case 'content_block_stop': {
                if (currentToolId) {
                  try {
                    const input = JSON.parse(currentToolInput)
                    onEvent({
                      type: 'tool_use',
                      id: currentToolId,
                      name: currentToolName,
                      input,
                    })
                  } catch {
                    onEvent({ type: 'error', error: 'Failed to parse tool input' })
                  }
                  currentToolId = ''
                  currentToolName = ''
                  currentToolInput = ''
                }
                break
              }
              case 'message_stop': {
                onEvent({
                  type: 'message_stop',
                  stop_reason: 'end_turn',
                  usage: event.usage
                    ? {
                        input_tokens: event.usage.input_tokens,
                        output_tokens: event.usage.output_tokens,
                        cache_creation_input_tokens: event.usage.cache_creation_input_tokens,
                        cache_read_input_tokens: event.usage.cache_read_input_tokens,
                      }
                    : undefined,
                })
                break
              }
              case 'error': {
                onEvent({ type: 'error', error: event.error?.message || 'Unknown error' })
                break
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async complete(request: LLMRequest, signal?: AbortSignal): Promise<{
    role: 'assistant'
    content: string
  }> {
    const url = `${this.baseURL}/v1/messages`

    const body = {
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API ${response.status}: ${errorText}`)
    }

    const data = await response.json()
    const text = data.content
      ?.filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('') || ''

    return { role: 'assistant', content: text }
  }
}

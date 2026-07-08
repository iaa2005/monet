/**
 * Chat message types for the renderer.
 */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  toolCall?: ToolCall
  isStreaming?: boolean
  isError?: boolean
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'done' | 'error'
}

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }
  | { type: 'error'; error: string }
  | { type: 'tool_result'; toolUseID: string; toolName: string; content: string }

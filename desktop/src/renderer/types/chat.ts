/**
 * Chat message types for the renderer.
 */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** Attachment metadata shown on a user message. `dataUrl` (image thumbnails)
 * lives only in the current session; `path` points at the artifact saved on
 * disk (<dataDir>/artifacts/<sessionId>/…) and IS persisted, so previews can
 * be re-read after a reload and files opened with the OS. */
export interface ChatAttachmentMeta {
  name: string
  mediaType: string
  kind: 'text' | 'image' | 'audio' | 'video' | 'file'
  dataUrl?: string
  path?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  toolCall?: ToolCall
  attachments?: ChatAttachmentMeta[]
  isStreaming?: boolean
  isError?: boolean
  /** Code Rewind: workspace snapshot taken after this (assistant) turn. */
  checkpointSha?: string
}

export interface SubAgentToolCall {
  name: string
  status: 'running' | 'done' | 'error'
}

/** Live state of a sub-agent launched via the Task tool, shown as a nested
 * card on the launching tool call. */
export interface SubAgentState {
  agentType: string
  description?: string
  /** Accumulated live text from the child (capped in the reducer). */
  text: string
  tools: SubAgentToolCall[]
  status: 'running' | 'done'
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'done' | 'error'
  subAgent?: SubAgentState
}

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }
  | { type: 'error'; error: string }
  | { type: 'tool_result'; toolUseID: string; toolName: string; content: string }
  | { type: 'checkpoint'; sha: string }
  | {
      type: 'subagent'
      toolUseID: string
      kind: 'start' | 'text' | 'tool' | 'tool_done' | 'done'
      agentType?: string
      description?: string
      text?: string
      name?: string
      isError?: boolean
    }

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

/** Live state of a sub-agent launched via the Task tool, shown as a nested
 * card on the launching tool call. The child's activity is a real mini
 * transcript (assistant text + tool calls) so it renders with the SAME
 * components as the main chat. */
export interface SubAgentState {
  agentType: string
  description?: string
  status: 'running' | 'done'
  /** Runs detached from the parent turn (Task run_in_background). */
  background?: boolean
  messages: ChatMessage[]
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
  | { type: 'user_message'; content: string }
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
      background?: boolean
      text?: string
      /** Child tool call id (kind 'tool' / 'tool_done'). */
      childId?: string
      name?: string
      input?: Record<string, unknown>
      output?: string
      isError?: boolean
    }

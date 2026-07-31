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
  /**
   * The browser tool produced this, not the user — a crop of an element they
   * pointed at. It still travels to the model as an image, but it belongs to
   * the ⟨chip⟩ that stands for that element, so the transcript draws it there
   * instead of beside the message as a file somebody chose to attach.
   */
  origin?: 'selection'
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
  /** Extended-thinking / reasoning text, shown only in Thinking mode. Display-
   * only: it is NEVER fed back into the model context. */
  reasoning?: string
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
  | { type: 'reasoning_delta'; text: string }
  | { type: 'user_message'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } }
  | { type: 'error'; error: string }
  /** `final` marks the RESULT. The placeholder before a tool runs and each
   * progress update arrive as this same event, so anything that closes a row
   * has to wait for it — see stores/chatStore.ts. */
  | {
      type: 'tool_result'
      toolUseID: string
      toolName: string
      content: string
      final?: boolean
    }
  | { type: 'checkpoint'; sha: string }
  /** Goal mode state, emitted on every change (see agent/goal/driver.ts). */
  | {
      type: 'goal'
      status: 'active' | 'paused' | 'blocked' | 'complete'
      objective: string
      turns: number
      maxTurns: number
      tokens: number
      maxTokens?: number
      detail?: string
    }
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

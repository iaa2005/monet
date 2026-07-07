import type { UUID } from 'crypto'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { SDKAssistantMessageError } from '../entrypoints/agentSdkTypes.js'
import type { Attachment } from '../utils/attachments.js'

// ─── Message-level enums ────────────────────────────────────────────────

export type SystemMessageLevel = 'info' | 'warn' | 'error' | 'debug'

export type PartialCompactDirection = 'forward' | 'backward' | null

export interface MessageOrigin {
  source: 'user' | 'system' | 'hook' | 'agent' | 'bridge' | 'remote' | 'sdk'
  agentId?: string
  hookName?: string
  bridgeClientId?: string
}

// ─── Base discriminated union ───────────────────────────────────────────

/**
 * Top-level message type — discriminated union on `type`.
 * Every message flowing through the agent loop is one of these.
 */
export type Message =
  | AssistantMessage
  | UserMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage
  | GroupedToolUseMessage

// ─── Assistant ──────────────────────────────────────────────────────────

export interface AssistantMessage {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: {
    id: string
    container: unknown | null
    model: string
    role: 'assistant'
    stop_reason: string | null
    stop_sequence: string
    type: 'message'
    usage?: Usage
    content: BetaContentBlock[]
    context_management: unknown | null
  }
  requestId?: string
  apiError?: {
    status: number
    message: string
    type: string
    requestId?: string
  }
  error?: SDKAssistantMessageError
  errorDetails?: string
  isApiErrorMessage?: boolean
  isVirtual?: true
  origin?: MessageOrigin
}

// ─── User ───────────────────────────────────────────────────────────────

export interface UserMessage {
  type: 'user'
  uuid: UUID
  timestamp: string
  isMeta: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: true
  isCompactSummary?: boolean
  summarizeMetadata?: {
    originalMessageCount: number
    compressedMessageCount: number
  }
  toolUseResult?: ToolResultBlockParam
  mcpMeta?: {
    serverName: string
    toolName: string
  }
  message: {
    role: 'user'
    content: string | BetaContentBlock[]
  }
  origin?: MessageOrigin
}

// ─── System (discriminated: subType) ────────────────────────────────────

export type SystemMessage =
  | SystemInformationalMessage
  | SystemAPIErrorMessage
  | SystemLocalCommandMessage
  | SystemApiMetricsMessage
  | SystemBridgeStatusMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemTurnDurationMessage
  | SystemPermissionRetryMessage
  | SystemStopHookSummaryMessage
  | SystemThinkingMessage
  | SystemMemorySavedMessage
  | SystemAwaySummaryMessage
  | SystemFileSnapshotMessage
  | SystemAgentsKilledMessage
  | SystemScheduledTaskFireMessage

interface SystemMessageBase {
  type: 'system'
  uuid: UUID
  timestamp: string
  isMeta: boolean
  level?: SystemMessageLevel
  toolUseID?: string
}

export interface SystemInformationalMessage extends SystemMessageBase {
  subtype: 'informational'
  content: string
  preventContinuation?: boolean
  origin?: MessageOrigin
}

export interface SystemAPIErrorMessage extends SystemMessageBase {
  subtype: 'api_error'
  content: string
  apiError: {
    status: number
    message: string
    type: string
    requestId?: string
  }
  error?: unknown
  isApiError?: boolean
  origin?: MessageOrigin
}

export interface SystemLocalCommandMessage extends SystemMessageBase {
  subtype: 'local_command'
  content: string
  origin?: MessageOrigin
}

export interface SystemApiMetricsMessage extends SystemMessageBase {
  subtype: 'api_metrics'
  content: string
  metrics: {
    ttftMs: number
    otps: number
    isP50?: boolean
    hookDurationMs?: number
    turnDurationMs?: number
    toolDurationMs?: number
    classifierDurationMs?: number
    toolCount?: number
    hookCount?: number
    classifierCount?: number
    inputTokens?: number
    outputTokens?: number
    cacheCreationTokens?: number
    cacheReadTokens?: number
    model?: string
  }
  origin?: MessageOrigin
}

export interface SystemBridgeStatusMessage extends SystemMessageBase {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
  origin?: MessageOrigin
}

export interface SystemCompactBoundaryMessage extends SystemMessageBase {
  subtype: 'compact_boundary'
  content: string
  trigger: 'manual' | 'auto'
  preTokens: number
  lastPreCompactMessageUuid?: UUID
  userContext?: string
  messagesSummarized?: number
  origin?: MessageOrigin
}

export interface SystemMicrocompactBoundaryMessage extends SystemMessageBase {
  subtype: 'microcompact_boundary'
  content: string
  trigger: 'auto'
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
  origin?: MessageOrigin
}

export interface SystemTurnDurationMessage extends SystemMessageBase {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
  origin?: MessageOrigin
}

export interface SystemPermissionRetryMessage extends SystemMessageBase {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  origin?: MessageOrigin
}

export interface SystemStopHookSummaryMessage extends SystemMessageBase {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  hookLabel?: string
  totalDurationMs?: number
  origin?: MessageOrigin
}

export interface SystemThinkingMessage extends SystemMessageBase {
  subtype: 'thinking'
  content: string
  origin?: MessageOrigin
}

export interface SystemMemorySavedMessage extends SystemMessageBase {
  subtype: 'memory_saved'
  writtenPaths: string[]
  origin?: MessageOrigin
}

export interface SystemAwaySummaryMessage extends SystemMessageBase {
  subtype: 'away_summary'
  content: string
  origin?: MessageOrigin
}

export interface SystemFileSnapshotMessage extends SystemMessageBase {
  subtype: 'file_snapshot'
  content: string
  filePath: string
  fileContent: string
  origin?: MessageOrigin
}

export interface SystemAgentsKilledMessage extends SystemMessageBase {
  subtype: 'agents_killed'
  origin?: MessageOrigin
}

export interface SystemScheduledTaskFireMessage extends SystemMessageBase {
  subtype: 'scheduled_task_fire'
  content: string
  origin?: MessageOrigin
}

// ─── Progress ───────────────────────────────────────────────────────────

export interface ProgressMessage<
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  type: 'progress'
  toolUseID: string
  parentToolUseID: string
  data: P
  uuid: UUID
  timestamp: string
}

// ─── Attachment ─────────────────────────────────────────────────────────

export interface AttachmentMessage {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: Attachment
  isMeta?: boolean
  origin?: MessageOrigin
}

// ─── Hook Result ────────────────────────────────────────────────────────

export interface HookResultMessage {
  type: 'hook_result'
  uuid: UUID
  timestamp: string
  hookName: string
  hookEvent: string
  content: string
  isMeta: boolean
  origin?: MessageOrigin
}

// ─── Grouped Tool Use ───────────────────────────────────────────────────

export interface GroupedToolUseMessage {
  type: 'grouped_tool_use'
  uuid: UUID
  timestamp: string
  toolName: string
  messageId: string
  messages: NormalizedAssistantMessage[]
  toolResultBlock?: ToolResultBlockParam
  isMeta?: boolean
  origin?: MessageOrigin
}

// ─── Collapsed / Collapsible ────────────────────────────────────────────

export interface CollapsedReadSearchGroup {
  type: 'collapsed_read_search'
  uuid: UUID
  timestamp: string
  toolName: string
  messages: NormalizedAssistantMessage[]
  toolUseIds: string[]
  isMeta?: boolean
  teamMemoryCount?: number
  origin?: MessageOrigin
}

export type CollapsibleMessage = NormalizedAssistantMessage | NormalizedUserMessage

// ─── Normalized variants ────────────────────────────────────────────────

/**
 * NormalizedAssistantMessage: always has `message.content` as a
 * concrete array (never string), plus normalized uuid/timestamp.
 */
export interface NormalizedAssistantMessage<
  T extends BetaContentBlock = BetaContentBlock,
> {
  type: 'assistant'
  uuid: string
  timestamp: string
  message: {
    id: string
    container: unknown | null
    model: string
    role: 'assistant'
    stop_reason: string | null
    stop_sequence: string
    type: 'message'
    usage?: Usage
    content: T[]
    context_management: unknown | null
  }
  isMeta?: boolean
  origin?: MessageOrigin
}

export interface NormalizedUserMessage {
  type: 'user'
  uuid: string
  timestamp: string
  message: {
    role: 'user'
    content: string | BetaContentBlock[]
  }
  isMeta: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: true
  toolUseResult?: ToolResultBlockParam
  mcpMeta?: {
    serverName: string
    toolName: string
  }
  origin?: MessageOrigin
}

export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

// ─── Renderable union (subset visible in UI) ────────────────────────────

export type RenderableMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

// ─── Stream / Request events ────────────────────────────────────────────

export interface StreamEvent {
  type: 'stream_event'
  event:
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_start'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
  index?: number
  contentBlock?: BetaContentBlock
  delta?: {
    type: 'text_delta' | 'input_json_delta'
    text?: string
    partial_json?: string
  }
  usage?: Usage
  message?: BetaMessage
  requestId?: string
}

export interface RequestStartEvent {
  type: 'request_start'
  requestId: string
  timestamp: string
  model: string
  messages: Message[]
}

export interface ToolUseSummaryMessage {
  type: 'tool_use_summary'
  uuid: UUID
  timestamp: string
  toolUseID: string
  toolName: string
  summary: string
  isMeta?: boolean
  origin?: MessageOrigin
}

export interface TombstoneMessage {
  type: 'tombstone'
  uuid: UUID
  timestamp: string
  originalType: string
  isMeta: boolean
}

// ─── Stop hook info (embedded in SystemStopHookSummaryMessage) ──────────

export interface StopHookInfo {
  hookName: string
  hookEvent: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

// ─── Compact metadata (attached during compaction) ──────────────────────

export interface CompactMetadata {
  compactedAt: number
  preTokens: number
  postTokens: number
  trigger: 'manual' | 'auto'
  messagesCompacted: number
}

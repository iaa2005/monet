/**
 * Runtime context for the vendor (leaked Claude Code) tools inside Electron.
 *
 * Provides the pieces the CLI would normally wire up in its REPL bootstrap:
 * the bootstrap cwd state, an AppState store, a FileStateCache, and a
 * ToolUseContext factory. Permission mode is bypassPermissions for now —
 * matches the previous hand-rolled agent behavior (no permission prompts);
 * the renderer PermissionDialog integration is a follow-up.
 */

import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { Tools, ToolUseContext } from '@vendor/Tool.js'
import type { AssistantMessage } from '@vendor/types/message.js'
import {
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '@vendor/bootstrap/state.js'
import {
  getDefaultAppState,
  type AppState,
} from '@vendor/state/AppStateStore.js'
import { enableConfigs } from '@vendor/utils/config.js'
import { FileStateCache } from '@vendor/utils/fileStateCache.js'
import { getWorkspacePath } from '../ipc/workspace.js'

// ─── Vendor runtime bootstrap ───────────────────────────────────────────

let initializedFor: string | null = null

/** Point the vendor bootstrap state at the current workspace. Safe to call
 * per message — re-inits only when the workspace changed. */
export function initVendorRuntime(): string {
  const ws = getWorkspacePath()
  if (initializedFor === ws) return ws

  // Windows: enable the dedicated PowerShellTool (external builds are opt-in).
  if (process.platform === 'win32') {
    process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL ??= '1'
  }

  // Vendor config reads are gated until the bootstrap opens them (guards
  // against config access at module-init time). Idempotent.
  enableConfigs()

  setOriginalCwd(ws)
  setProjectRoot(ws)
  setCwdState(ws)
  // Workspace switch invalidates app state (permission ctx, todos, caches).
  appState = null
  initializedFor = ws
  return ws
}

// ─── AppState store (headless — no React) ───────────────────────────────

let appState: AppState | null = null

export function getAppState(): AppState {
  if (!appState) {
    const state = getDefaultAppState()
    appState = {
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        mode: 'bypassPermissions',
        isBypassPermissionsModeAvailable: true,
      },
    }
  }
  return appState
}

export function setAppState(f: (prev: AppState) => AppState): void {
  appState = f(getAppState())
}

// ─── ToolUseContext factory ─────────────────────────────────────────────

/** One FileStateCache per session so Read-before-Edit checks work across
 * turns of the same conversation. */
const fileStateCaches = new Map<string, FileStateCache>()

export function dropSessionContext(sessionId: string): void {
  fileStateCaches.delete(sessionId)
}

export function createToolUseContext(opts: {
  sessionId: string
  tools: Tools
  model: string
  signal?: AbortSignal
}): ToolUseContext {
  const { sessionId, tools, model, signal } = opts

  let readFileState = fileStateCaches.get(sessionId)
  if (!readFileState) {
    readFileState = new FileStateCache(100, 25 * 1024 * 1024)
    fileStateCaches.set(sessionId, readFileState)
  }

  const abortController = new AbortController()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: model,
      tools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController,
    readFileState,
    getAppState,
    setAppState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: updater =>
      setAppState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) })),
    updateAttributionState: updater =>
      setAppState(prev => ({ ...prev, attribution: updater(prev.attribution) })),
    messages: [],
  }
}

// ─── Parent message for tool.call() ─────────────────────────────────────

/** Minimal AssistantMessage carrying the tool_use block — some tools read
 * ids/model off it. */
export function createParentAssistantMessage(
  model: string,
  toolUseID: string,
  name: string,
  input: Record<string, unknown>,
): AssistantMessage {
  const uuid = randomUUID() as UUID
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_${uuid}`,
      container: null,
      model,
      role: 'assistant',
      stop_reason: null,
      stop_sequence: '',
      type: 'message',
      content: [
        {
          type: 'tool_use',
          id: toolUseID,
          name,
          input,
        } as AssistantMessage['message']['content'][number],
      ],
      context_management: null,
    },
  }
}

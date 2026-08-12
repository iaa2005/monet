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
import type { Tools, ToolUseContext } from '../engine/Tool.js'
import type { AssistantMessage } from '../engine/types/message.js'
import {
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../engine/state/state.js'
import {
  getDefaultAppState,
  type AppState,
} from '../engine/state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../engine/Tool.js'
import type { PermissionMode } from '../engine/types/permissions.js'
import { enableConfigs } from '../engine/utils/config.js'
import { reloadHooks } from './tool-hooks.js'
import { FileStateCache } from '../engine/utils/fileStateCache.js'
import { join } from 'path'
import { getDataDir } from '../data-dir.js'
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

  // Move the vendor's entire config home into our data dir. getClaudeConfigHomeDir()
  // defaults to ~/.claude and is memoized on this variable, so it must be set
  // before anything reads it. This app does not use ~/.claude: user settings,
  // the projects dir and the memory base all resolve under <dataDir>/claude,
  // and the user's real Claude Code CLI config is left untouched.
  process.env.CLAUDE_CONFIG_DIR ??= join(getDataDir(), 'claude')

  // Vendor config reads are gated until the bootstrap opens them (guards
  // against config access at module-init time). Idempotent.
  enableConfigs()

  setOriginalCwd(ws)
  setProjectRoot(ws)
  setCwdState(ws)
  // Load this app's hooks from <dataDir>/hooks.json. Deliberately NOT the
  // vendor's settings channel: that would read ~/.claude and, worse, the
  // opened project's .claude/settings.json — a cloned repo could ship a
  // PreToolUse hook naming any shell command and it would run before the user
  // saw anything.
  void reloadHooks().catch(() => {})
  // Workspace switch invalidates app state (permission ctx, todos, caches).
  appState = null
  initializedFor = ws
  return ws
}

// ─── AppState store (headless — no React) ───────────────────────────────

let appState: AppState | null = null

// The vendor PermissionMode the tools' checkPermissions() run against. Driven
// by the UI mode selector via setVendorPermissionMode(). 'default' asks for
// risky actions (routed to the renderer dialog); the executor layer maps the
// UI "Auto" mode onto 'default' + its own heuristic (see vendor-tools.ts).
let vendorMode: PermissionMode = 'default'

function buildPermissionContext(mode: PermissionMode): AppState['toolPermissionContext'] {
  return {
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: true,
  }
}

export function setVendorPermissionMode(mode: PermissionMode): void {
  vendorMode = mode
  if (appState) {
    appState = {
      ...appState,
      toolPermissionContext: buildPermissionContext(mode),
    }
  }
}

export function getAppState(): AppState {
  if (!appState) {
    const state = getDefaultAppState()
    appState = {
      ...state,
      toolPermissionContext: buildPermissionContext(vendorMode),
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

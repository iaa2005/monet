/**
 * Vendor toolset — the real Claude Code tools from vendor/leaked, assembled
 * directly (vendor tools.ts is CLI-oriented: require() conditionals,
 * Tungsten/testing tools). Execution goes through the tools' own
 * validateInput → checkPermissions → call pipeline; results come back via
 * each tool's mapToolResultToToolResultBlockParam, flattened to text for the
 * LLM adapter layer.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Tool, Tools, ToolUseContext } from '@vendor/Tool.js'
import { findToolByName } from '@vendor/Tool.js'
import { BashTool } from '@vendor/tools/BashTool/BashTool.js'
import { FileEditTool } from '@vendor/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '@vendor/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from '@vendor/tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from '@vendor/tools/GlobTool/GlobTool.js'
import { GrepTool } from '@vendor/tools/GrepTool/GrepTool.js'
import { PowerShellTool } from '@vendor/tools/PowerShellTool/PowerShellTool.js'
import { TodoWriteTool } from '@vendor/tools/TodoWriteTool/TodoWriteTool.js'
import { zodToJsonSchema } from '@vendor/utils/zodToJsonSchema.js'
import { InlineSkillTool } from './skill-tool.js'
import type { LLMTool } from '../llm/adapter.js'
import {
  createParentAssistantMessage,
  createToolUseContext,
  getAppState,
  initVendorRuntime,
  setVendorPermissionMode,
} from './vendor-context.js'

// ─── Permission modes ─────────────────────────────────────────────────────

/** The 5 UI permission levels. Map to the vendor PermissionMode the tools'
 * checkPermissions() run against — 'auto' has no vendor equivalent (needs the
 * Anthropic classifier we can't run), so it uses 'default' + a local heuristic. */
export type UiPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions'

export type PermissionAsk = {
  toolName: string
  description: string
  detail?: string
}
export type PermissionDecision = 'allow' | 'allow-once' | 'deny'
export type RequestPermission = (ask: PermissionAsk) => Promise<PermissionDecision>

const VENDOR_MODE_FOR: Record<UiPermissionMode, 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'default',
  bypassPermissions: 'bypassPermissions',
}

// Tools "Auto" mode runs without asking (read/search + file mutations). Shell
// tools and anything else still prompt.
const AUTO_ALLOW_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  'TodoWrite',
])

// Per-session "Allow always" grants (keyed by sessionId:toolName) so a tool the
// user approved with "Allow always" won't prompt again this session.
const sessionAllowAlways = new Set<string>()

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

function describeAsk(
  tool: Tool,
  input: Record<string, unknown>,
): { description: string; detail?: string } {
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined
  const name = tool.name
  if (name === 'Bash' || name === 'PowerShell') {
    return { description: `Run a ${name} command`, detail: str('command') }
  }
  const path = str('file_path') ?? str('path')
  if (name === 'Write') return { description: `Create or overwrite ${path ? baseName(path) : 'a file'}`, detail: path }
  if (name === 'Edit' || name === 'MultiEdit')
    return { description: `Edit ${path ? baseName(path) : 'a file'}`, detail: path }
  if (name === 'Read') return { description: `Read ${path ? baseName(path) : 'a file'}`, detail: path }
  const first = str('command') ?? str('pattern') ?? str('query') ?? str('url') ?? path
  return { description: `Run ${name}`, detail: first }
}

type GateResult = { behavior: 'allow'; input: Record<string, unknown> } | { behavior: 'deny'; message: string }

async function gatePermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  permissionMode: UiPermissionMode
  requestPermission?: RequestPermission
  sessionId: string
}): Promise<GateResult> {
  const { tool, input, context, permissionMode, requestPermission, sessionId } = args

  if (permissionMode === 'bypassPermissions') return { behavior: 'allow', input }

  // Plan mode: only read-only tools may run until the user approves the plan.
  if (permissionMode === 'plan') {
    if (tool.isReadOnly(input)) return { behavior: 'allow', input }
    return {
      behavior: 'deny',
      message: `Plan mode is active — ${tool.name} is blocked. Present the plan and let the user switch modes before making changes.`,
    }
  }

  const allowKey = `${sessionId}:${tool.name}`
  if (sessionAllowAlways.has(allowKey)) return { behavior: 'allow', input }

  const perm = await tool.checkPermissions(input, context)
  if (perm.behavior === 'deny') {
    return { behavior: 'deny', message: `Permission denied: ${perm.message}` }
  }
  const nextInput =
    (perm.behavior === 'allow' && perm.updatedInput) || input
  if (perm.behavior === 'allow') return { behavior: 'allow', input: nextInput }

  // perm.behavior is 'ask' (or 'passthrough') — needs a decision.
  if (permissionMode === 'auto') {
    if (tool.isReadOnly(input) || AUTO_ALLOW_TOOLS.has(tool.name)) {
      return { behavior: 'allow', input: nextInput }
    }
  }

  if (!requestPermission) {
    return {
      behavior: 'deny',
      message: `${tool.name} needs permission but no prompt channel is available.`,
    }
  }
  const { description, detail } = describeAsk(tool, input)
  const decision = await requestPermission({
    toolName: tool.userFacingName(input) || tool.name,
    description,
    detail,
  })
  if (decision === 'deny') {
    return { behavior: 'deny', message: `The user declined to run ${tool.name}.` }
  }
  if (decision === 'allow') sessionAllowAlways.add(allowKey)
  return { behavior: 'allow', input: nextInput }
}

/** Clear a session's "Allow always" grants (on New session / reset). */
export function clearSessionGrants(sessionId: string): void {
  for (const key of sessionAllowAlways) {
    if (key.startsWith(`${sessionId}:`)) sessionAllowAlways.delete(key)
  }
}

// ─── Toolset ────────────────────────────────────────────────────────────

let cachedTools: Tools | null = null
let cachedForWorkspace: string | null = null

export function getVendorTools(): Tools {
  const ws = initVendorRuntime()
  if (ws !== cachedForWorkspace) {
    // Workspace switch: tool enablement and prompt content (cwd, git) change.
    cachedTools = null
    apiToolsCache.clear()
    cachedForWorkspace = ws
  }
  if (cachedTools) return cachedTools
  const all = [
    BashTool,
    PowerShellTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    TodoWriteTool,
    InlineSkillTool,
  ] as unknown as Tool[]
  cachedTools = all.filter(t => t.isEnabled())
  return cachedTools
}

/** Reset cached tools (workspace switch changes isEnabled outcomes). */
export function resetVendorTools(): void {
  cachedTools = null
  apiToolsCache.clear()
}

// ─── API schema conversion (adapter-facing) ─────────────────────────────

const apiToolsCache = new Map<string, LLMTool[]>()

// (declared before getVendorTools uses it at runtime — module-level const
// hoisting via TDZ is satisfied because getVendorTools runs post-init)

export async function getVendorApiTools(): Promise<LLMTool[]> {
  const tools = getVendorTools()
  const cacheKey = tools.map(t => t.name).join(',')
  const hit = apiToolsCache.get(cacheKey)
  if (hit) return hit

  const promptOptions = {
    getToolPermissionContext: async () => getAppState().toolPermissionContext,
    tools,
    agents: [],
  }

  const apiTools: LLMTool[] = await Promise.all(
    tools.map(async tool => {
      const schema = zodToJsonSchema(tool.inputSchema) as LLMTool['input_schema']
      return {
        name: tool.name,
        description: await tool.prompt(promptOptions),
        input_schema: {
          type: 'object' as const,
          properties: schema.properties ?? {},
          ...(schema.required ? { required: schema.required } : {}),
        },
      }
    }),
  )
  apiToolsCache.set(cacheKey, apiTools)
  return apiTools
}

// ─── Execution ──────────────────────────────────────────────────────────

function flattenToolResultContent(
  content: ToolResultBlockParam['content'],
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'image') return '[image attached]'
      return JSON.stringify(block)
    })
    .join('\n')
}

export interface VendorToolResult {
  content: string
  isError: boolean
}

/** The tool.call() canUseTool hook — gating already happened in gatePermission
 * (which routes asks to the UI), so this simply confirms the pre-approved run. */
const canUseTool = async (
  _tool: unknown,
  input: Record<string, unknown>,
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => ({
  behavior: 'allow',
  updatedInput: input,
})

export async function executeVendorTool(opts: {
  sessionId: string
  toolUseID: string
  name: string
  input: Record<string, unknown>
  model: string
  permissionMode?: UiPermissionMode
  requestPermission?: RequestPermission
  signal?: AbortSignal
  onProgress?: (text: string) => void
}): Promise<VendorToolResult> {
  const {
    sessionId,
    toolUseID,
    name,
    input,
    model,
    permissionMode = 'default',
    requestPermission,
    signal,
  } = opts
  initVendorRuntime()
  // Point the vendor tools' checkPermissions() at the selected mode.
  setVendorPermissionMode(VENDOR_MODE_FOR[permissionMode])
  const tools = getVendorTools()
  const tool = findToolByName(tools, name)
  if (!tool) {
    return { content: `Unknown tool: ${name}`, isError: true }
  }

  const context: ToolUseContext = createToolUseContext({
    sessionId,
    tools,
    model,
    signal,
  })
  ;(context as { toolUseId?: string }).toolUseId = toolUseID

  try {
    // 1. Schema parse (defaults, coercions, strictness) — the query engine
    //    does this before validateInput.
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        content: `InputValidationError: ${parsed.error.message}`,
        isError: true,
      }
    }
    const toolInput = parsed.data as Record<string, unknown>

    // 2. Tool-specific validation.
    if (tool.validateInput) {
      const validation = await tool.validateInput(toolInput, context)
      if (!validation.result) {
        return { content: `Error: ${validation.message}`, isError: true }
      }
    }

    // 3. Permission gate — mode-aware; routes 'ask' decisions to the UI.
    const gate = await gatePermission({
      tool,
      input: toolInput,
      context,
      permissionMode,
      requestPermission,
      sessionId,
    })
    if (gate.behavior === 'deny') {
      return { content: gate.message, isError: true }
    }
    const finalInput = gate.input

    // 4. Execute.
    const parentMessage = createParentAssistantMessage(
      model,
      toolUseID,
      tool.name,
      finalInput,
    )
    const result = await tool.call(
      finalInput,
      context,
      canUseTool as never,
      parentMessage,
      undefined,
    )

    // 5. Serialize the result the way the API layer would.
    const block = tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    )
    return {
      content: flattenToolResultContent(block.content),
      isError: block.is_error === true,
    }
  } catch (err) {
    if (signal?.aborted) {
      return { content: 'Tool execution aborted', isError: true }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${message}`, isError: true }
  }
}

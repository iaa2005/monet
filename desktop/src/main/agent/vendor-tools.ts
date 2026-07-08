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
import type { LLMTool } from '../llm/adapter.js'
import {
  createParentAssistantMessage,
  createToolUseContext,
  getAppState,
  initVendorRuntime,
} from './vendor-context.js'

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

/** Auto-allow: permission mode is bypassPermissions; asks resolve to allow. */
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
  signal?: AbortSignal
  onProgress?: (text: string) => void
}): Promise<VendorToolResult> {
  const { sessionId, toolUseID, name, input, model, signal } = opts
  initVendorRuntime()
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

    // 3. Permission check (bypass mode: rules still run, asks auto-allow).
    const permission = await tool.checkPermissions(toolInput, context)
    if (permission.behavior === 'deny') {
      return {
        content: `Permission denied: ${permission.message}`,
        isError: true,
      }
    }
    const finalInput =
      (permission.behavior === 'allow' && permission.updatedInput) ||
      toolInput

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

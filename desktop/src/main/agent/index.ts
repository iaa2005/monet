/**
 * Agent wrapper — orchestrates the LLM + tool execution loop.
 *
 * This is a simplified TAOR (Think-Act-Observe-Respond) loop for the MVP.
 * Full integration with vendor QueryEngine will come in later iterations.
 */

import type { LLMAdapter, LLMEvent, LLMMessage, LLMRequest, LLMTool } from '../llm/adapter.js'
import { getProviderManager } from '../provider/manager.js'
import { createAdapter } from '../llm/adapter.js'
import { getWorkspacePath } from '../ipc/workspace.js'

// ─── Basic built-in tools ───────────────────────────────────────────────

const BUILTIN_TOOLS: LLMTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return the output',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
      },
      required: ['command'],
    },
  },
]

// ─── Tool execution ─────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'read_file': {
      const { readFileSync, existsSync } = await import('fs')
      const path = input.path as string
      if (!existsSync(path)) return `Error: File not found: ${path}`
      try {
        return readFileSync(path, 'utf-8')
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`
      }
    }
    case 'run_command': {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const command = input.command as string
      const cwd = getWorkspacePath()
      try {
        const { stdout, stderr } = await promisify(exec)(command, {
          cwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        })
        return stdout || stderr || '(no output)'
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message: string }
        return execErr.stderr || execErr.stdout || execErr.message
      }
    }
    default:
      return `Unknown tool: ${name}`
  }
}

// ─── Agent loop ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  systemPrompt?: string
  maxTurns?: number
  signal?: AbortSignal
}

const DEFAULT_SYSTEM = `You are a helpful AI assistant with access to tools.
Use tools when you need to read files or run commands.
Always explain your reasoning before using a tool.
When you're done with your task, summarize what you did.`

export async function runAgent(
  userMessage: string,
  onEvent: (event: LLMEvent) => void,
  options: AgentRunOptions = {},
): Promise<void> {
  const provider = getProviderManager().getActive()
  if (!provider) {
    onEvent({ type: 'error', error: 'No active provider configured' })
    return
  }

  const adapter = createAdapter(provider)
  const { systemPrompt = DEFAULT_SYSTEM, maxTurns = 10, signal } = options

  const messages: LLMMessage[] = [
    { role: 'user', content: userMessage },
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) break

    const pendingToolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []

    const request: LLMRequest = {
      model: provider.model,
      system: systemPrompt,
      messages,
      tools: BUILTIN_TOOLS,
      max_tokens: 4096,
    }

    await adapter.stream(
      request,
      (event) => {
        if (event.type === 'tool_use') {
          pendingToolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          })
        }
        onEvent(event)
      },
      signal,
    )

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) break

    // Execute tool calls
    for (const tc of pendingToolCalls) {
      const result = await executeTool(tc.name, tc.input)
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          },
        ],
      })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: result,
          },
        ],
      })
    }
  }
}

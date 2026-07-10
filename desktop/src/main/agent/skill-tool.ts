/**
 * Skill tool (desktop-native).
 *
 * The vendor SkillTool either injects vendor `newMessages` into the transcript
 * or forks a sub-agent via the query engine — neither fits our adapter loop.
 * This inline version does the useful part directly: it resolves a skill by
 * name and expands its prompt via the official `command.getPromptForCommand()`
 * accessor, then returns that text as the tool result so the MAIN model reads
 * the skill's instructions and follows them in the current turn.
 *
 * Skills are discovered from the standard locations by vendor getCommands():
 *   - <CLAUDE_CONFIG_DIR>/skills/**   (user)
 *   - <workspace>/.claude/skills/**   (project)
 *   - bundled skills
 * Adding this tool to the toolset ALSO makes the system prompt's
 * session-guidance section list the available skills (it gates on the Skill
 * tool being enabled).
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '@vendor/Tool.js'
import { findCommand, getCommands, getSkillToolCommands } from '@vendor/commands.js'
import { getProjectRoot } from '@vendor/bootstrap/state.js'
import type { Command } from '@vendor/types/command.js'
import { lazySchema } from '@vendor/utils/lazySchema.js'
import { initVendorRuntime } from './vendor-context.js'

/**
 * Expand a user-typed slash command ("/name args") into its prompt text —
 * the same client-side expansion the CLI does. Returns null when the input
 * isn't a known prompt command, so the caller can send the raw text instead.
 */
export async function expandSlashCommand(
  message: string,
): Promise<string | null> {
  const m = message.match(/^\/([A-Za-z0-9_:./-]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  try {
    initVendorRuntime()
    const root = getProjectRoot()
    // SKILL.md skills live in the skill catalog, not the command registry —
    // search both so "/my-skill" expands too.
    const [commands, skillCmds] = await Promise.all([
      getCommands(root),
      getSkillToolCommands(root).catch(() => [] as Command[]),
    ])
    const command =
      findCommand(m[1], commands) ?? skillCmds.find(c => c.name === m[1])
    if (
      !command ||
      typeof (command as { getPromptForCommand?: unknown })
        .getPromptForCommand !== 'function'
    )
      return null
    // Minimal context: prompt expanders mostly read cwd/args; the abort
    // controller satisfies the common interface bits.
    const ctx = {
      abortController: new AbortController(),
      options: { commands, tools: [], debug: false },
    } as unknown as ToolUseContext
    const blocks = await (
      command as {
        getPromptForCommand: (
          args: string,
          ctx: ToolUseContext,
        ) => Promise<ContentBlockParam[]>
      }
    ).getPromptForCommand(m[2] ?? '', ctx)
    const text = flattenBlocks(blocks)
    if (!text) return null
    return (
      `<command name="/${m[1]}"${m[2] ? ` args=${JSON.stringify(m[2])}` : ''}>\n` +
      `${text}\n</command>\n\n` +
      `Follow the command instructions above.`
    )
  } catch (err) {
    console.warn(
      '[slash] expansion failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    skill: z
      .string()
      .describe('The name of the skill to invoke (as listed in the skill catalog).'),
    args: z
      .string()
      .optional()
      .describe('Optional arguments passed to the skill.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

interface SkillOutput {
  text: string
  isError: boolean
}

function flattenBlocks(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text') return b.text
      if (b.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

async function listSkills(): Promise<Command[]> {
  try {
    return await getSkillToolCommands(getProjectRoot())
  } catch {
    return []
  }
}

function skillCatalog(skills: Command[]): string {
  if (skills.length === 0) return 'No skills are currently available.'
  const lines = skills.map(s => {
    const desc =
      ('whenToUse' in s && s.whenToUse) ||
      ('description' in s && s.description) ||
      ''
    return `- ${s.name}${desc ? `: ${desc}` : ''}`
  })
  return `Available skills:\n${lines.join('\n')}`
}

export const InlineSkillTool = buildTool({
  name: 'Skill',
  searchHint: 'invoke a named skill / reusable prompt',
  maxResultSizeChars: 60_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return 'Skill'
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async prompt() {
    const skills = await listSkills()
    return [
      'Invoke a skill: a reusable, named prompt that packages instructions for a',
      'specific task. Pass the skill `name`; its instructions are loaded into the',
      'conversation and you then carry them out. Only invoke a skill listed below.',
      '',
      skillCatalog(skills),
    ].join('\n')
  },
  async description() {
    return 'Invoke a named skill (reusable prompt) so its instructions guide the current task.'
  },
  async call(
    { skill, args }: z.infer<InputSchema>,
    context: ToolUseContext,
  ) {
    const name = skill.trim().replace(/^\//, '')
    let commands: Command[]
    try {
      commands = await getCommands(getProjectRoot())
    } catch (err) {
      return {
        data: {
          text: `Error loading skills: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      }
    }

    const command = findCommand(name, commands)
    if (!command) {
      const skills = await listSkills()
      return {
        data: {
          text: `Unknown skill: ${name}.\n${skillCatalog(skills)}`,
          isError: true,
        },
      }
    }
    if (command.type !== 'prompt') {
      return {
        data: { text: `Skill "${name}" is not a prompt-based skill.`, isError: true },
      }
    }
    if (command.disableModelInvocation) {
      return {
        data: { text: `Skill "${name}" cannot be invoked by the model.`, isError: true },
      }
    }

    try {
      const blocks = await command.getPromptForCommand(args ?? '', context)
      const text = flattenBlocks(blocks)
      return {
        data: {
          text:
            `<skill name="${name}">\n${text}\n</skill>\n\n` +
            `Follow the skill instructions above to complete the task.`,
          isError: false,
        },
      }
    } catch (err) {
      return {
        data: {
          text: `Error running skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(
    content: SkillOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: content.text,
      is_error: content.isError || undefined,
    }
  },
  renderToolUseMessage() {
    return null
  },
})

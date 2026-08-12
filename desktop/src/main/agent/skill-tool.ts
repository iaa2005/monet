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

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '@vendor/Tool.js'
import { findCommand, getCommands, getSkillToolCommands } from '@vendor/commands.js'
import { getProjectRoot } from '@vendor/bootstrap/state.js'
import type { Command } from '@vendor/types/command.js'
import { lazySchema } from './lazy-schema.js'
import { rebrand } from '@shared/rebrand.js'
import { getAppState, initVendorRuntime } from './vendor-context.js'
import { copyBufferIntoSandbox } from '../sandbox/files.js'
import { tunablePrompt } from '../prompts/index.js'

// Home is isolated: a skill's "Base directory" host path is unreachable there.
// Copy the skill's bundled files into the chat sandbox — recursively, preserving
// subfolders — so SandboxRead and RunPython can use them at the same relative
// paths the skill's instructions reference (e.g. scripts/office/pack.py).
const SKILL_COPY_MAX_FILE = 2 * 1024 * 1024 // 2 MB per file
const SKILL_COPY_MAX_TOTAL = 12 * 1024 * 1024 // 12 MB total
const SKILL_COPY_MAX_COUNT = 200

function copySkillFilesToSandbox(
  sessionId: string,
  skillDir: string,
): string[] {
  const copied: string[] = []
  let total = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of entries) {
      if (copied.length >= SKILL_COPY_MAX_COUNT) return
      const full = join(dir, e)
      const rel = relative(skillDir, full).split(sep).join('/')
      if (rel === 'SKILL.md') continue // already inlined into the prompt
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile()) continue
      if (st.size === 0 || st.size > SKILL_COPY_MAX_FILE) continue
      if (total + st.size > SKILL_COPY_MAX_TOTAL) return
      try {
        if (copyBufferIntoSandbox(sessionId, rel, readFileSync(full))) {
          copied.push(rel)
          total += st.size
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  walk(skillDir)
  return copied
}

/**
 * Copy a skill's bundled files into the chat sandbox and return the note that
 * tells the model they are there — or '' if there was nothing to bridge.
 *
 * A skill's "Base directory" is a HOST path. In Home (and any sandboxed chat)
 * that path is unreachable, so a skill whose SKILL.md says "read
 * SKILL-tearsheet.md" or "run scripts/foo.py" sends the model hunting: it
 * tries SandboxRead on a host path (refused), then a bare relative path
 * (absent), then RunCommand/find (nothing), and only recovers if it thinks to
 * call the Skill tool — which is the one place that used to do this copy.
 * Measured: five wasted steps before recovery on the equity-research skill.
 * Both entry points (this tool AND the slash-command expansion) bridge now, so
 * the files are already in place at the SAME relative paths the moment the
 * instructions arrive.
 */
export function bridgeSkillFilesToSandbox(
  sessionId: string,
  skillDir: string,
): string {
  const copied = copySkillFilesToSandbox(sessionId, skillDir)
  if (copied.length === 0) return ''
  const shown = copied.slice(0, 20).join(', ')
  const more = copied.length > 20 ? ` (+${copied.length - 20} more)` : ''
  return (
    `\n\n---\n[Sandbox] This chat is isolated, so the skill's host "Base ` +
    `directory" above is NOT reachable — do not try to read it or find it on ` +
    `disk. The skill's files were copied into this chat's sandbox at the SAME ` +
    `relative paths (subfolders preserved): read them with SandboxRead or open ` +
    `them from RunPython (cwd is the sandbox root): ${shown}${more}. Some ` +
    `bundled scripts may rely on tools unavailable in the sandbox (e.g. ` +
    `LibreOffice); prefer generating output directly with RunPython.`
  )
}

/**
 * Expand a user-typed slash command ("/name args") into its prompt text —
 * the same client-side expansion the CLI does. Returns null when the input
 * isn't a known prompt command, so the caller can send the raw text instead.
 *
 * When the command IS a skill and the chat is sandboxed (Home), the skill's
 * bundled files are bridged into the sandbox here too — not only when the
 * model calls the Skill tool. Without this, "/my-skill" handed the model
 * instructions that referenced files it could not reach, and it burned several
 * turns hunting for them before recovering. See bridgeSkillFilesToSandbox.
 */
export async function expandSlashCommand(
  message: string,
  opts: { sessionId?: string; space?: string } = {},
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
    const vendorCommand = findCommand(m[1], commands)
    const command = vendorCommand ?? skillCmds.find(c => c.name === m[1])
    if (
      !command ||
      typeof (command as { getPromptForCommand?: unknown })
        .getPromptForCommand !== 'function'
    )
      return null
    // A REAL context, because some expanders do real work. This used to be a
    // hand-made stub of {abortController, options} — enough for the expanders
    // that only read cwd and args, and a TypeError for every one that runs an
    // inline shell command (`` !`git diff` ``): those go through
    // executeShellCommandsInPrompt → hasPermissionsToUseTool, which calls
    // context.getAppState(). The throw was swallowed by the catch below and
    // the caller sent the model the literal text "/security-review", so the
    // command looked like it did nothing. Same for any SKILL whose SKILL.md
    // embeds a shell block.
    const ctx = {
      abortController: new AbortController(),
      options: { commands, tools: [], debug: false },
      getAppState,
      setAppState: () => {},
      getToolPermissionContext: () => getAppState().toolPermissionContext,
    } as unknown as ToolUseContext
    const blocks = await (
      command as {
        getPromptForCommand: (
          args: string,
          ctx: ToolUseContext,
        ) => Promise<ContentBlockParam[]>
      }
    ).getPromptForCommand(m[2] ?? '', ctx)
    // The same rename the menu gets — and this copy goes to the MODEL, which
    // is where the brand actually bites: /init's prompt says "create a
    // CLAUDE.md file, which will be given to future instances of Claude Code",
    // so the model dutifully wrote upstream's file under upstream's name. We
    // read both memory files (MEMORY_FILENAMES) but write ours.
    //
    // ONLY for commands that came from the vendor registry. A skill is the
    // user's own writing, and rewriting names inside it would be exactly the
    // over-reach shared/rebrand is careful to avoid elsewhere — if their skill
    // says CLAUDE.md, it means CLAUDE.md.
    let text = flattenBlocks(blocks)
    if (vendorCommand) text = rebrand(text)
    if (!text) return null
    // Same bridge the Skill tool does: a skill invoked by slash needs its
    // files in the sandbox just as much as one invoked by tool call.
    const skillDir = (command as { skillRoot?: string }).skillRoot
    if (opts.space === 'home' && skillDir)
      text += bridgeSkillFilesToSandbox(opts.sessionId || 'default', skillDir)
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
    const preamble = tunablePrompt(
      'tool-skill',
      [
        'Invoke a skill: a reusable, named prompt that packages instructions for a',
        'specific task. Pass the skill `name`; its instructions are loaded into the',
        'conversation and you then carry them out. Only invoke a skill listed below.',
      ].join('\n'),
    )
    return `${preamble}\n\n${skillCatalog(skills)}`
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
      let text = flattenBlocks(blocks)

      // In Home the skill's bundled files live on the host FS, which the
      // isolated chat cannot read — bridge them into the chat sandbox so
      // SandboxRead / RunPython can use them.
      const space = (context as { space?: string }).space
      const sessionId = (context as { sessionId?: string }).sessionId || 'default'
      const skillDir = (command as { skillRoot?: string }).skillRoot
      if (space === 'home' && skillDir)
        text += bridgeSkillFilesToSandbox(sessionId, skillDir)

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

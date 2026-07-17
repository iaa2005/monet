/**
 * Runtime smoke for the vendor tool pipeline — runs under plain Node (no
 * Electron): lists tools, converts schemas, greps the repo, writes+reads a
 * temp file, runs a shell command, and builds the vendor system prompt.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorTools,
} from '../src/main/agent/vendor-tools.js'
import { initVendorRuntime } from '../src/main/agent/vendor-context.js'
import { shouldCompact, compactMessages } from '../src/main/agent/compaction.js'
import {
  callMcpTool,
  ensureConnected,
  getMcpTools,
  isMcpToolName,
  loadConfig,
} from '../src/main/mcp/manager.js'
import type { LLMAdapter, LLMMessage } from '../src/main/llm/adapter.js'

const MODEL = 'claude-opus-4-8'
let failures = 0

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function run(
  name: string,
  input: Record<string, unknown>,
  // A check may need to pick the permission mode, and separately to say whether
  // anyone is watching — CreateRoutine keys off the latter. Anything other than
  // bypass needs a prompt channel, or the gate denies before the tool is
  // reached — hence the auto-allow stub.
  opts?: {
    permissionMode?: 'default' | 'bypassPermissions'
    unattended?: boolean
  },
) {
  const mode = opts?.permissionMode ?? 'bypassPermissions'
  return executeVendorTool({
    sessionId: 'smoke',
    toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
    name,
    input,
    model: MODEL,
    // Backend harness: no UI to prompt, so bypass the permission gate.
    permissionMode: mode,
    unattended: opts?.unattended,
    ...(mode === 'bypassPermissions'
      ? {}
      : { requestPermission: async () => ({ behavior: 'allow' as const }) }),
  })
}

async function main() {
  initVendorRuntime()

  // 1. Toolset + API schemas
  const tools = getVendorTools()
  console.log('tools:', tools.map(t => t.name).join(', '))
  check('toolset non-empty', tools.length >= 6)

  const apiTools = await getVendorApiTools()
  const grepApi = apiTools.find(t => t.name === 'Grep')
  check(
    'Grep schema has pattern prop',
    !!grepApi && 'pattern' in (grepApi.input_schema.properties ?? {}),
  )
  const bashApi = apiTools.find(t => t.name === 'Bash')
  check(
    'Bash description non-trivial',
    !!bashApi && bashApi.description.length > 500,
    `len=${bashApi?.description.length}`,
  )

  // 2. Grep over the repo
  const grep = await run('Grep', {
    pattern: 'export async function getSystemPrompt',
    path: 'src/vendor/leaked/constants',
    output_mode: 'files_with_matches',
  })
  check(
    'Grep finds prompts.ts',
    !grep.isError && grep.content.includes('prompts.ts'),
    grep.content.split('\n')[0],
  )

  // 3. Glob
  const glob = await run('Glob', { pattern: 'src/main/agent/*.ts' })
  check(
    'Glob finds agent files',
    !glob.isError && glob.content.includes('vendor-tools.ts'),
  )

  // 4. Write → Read → Edit cycle in a temp dir
  const dir = mkdtempSync(join(tmpdir(), 'vendor-smoke-'))
  const file = join(dir, 'smoke.txt')
  const write = await run('Write', { file_path: file, content: 'hello vendor tools\nline two\n' })
  check('Write ok', !write.isError, write.content.slice(0, 80))
  const read = await run('Read', { file_path: file })
  check('Read returns content', !read.isError && read.content.includes('hello vendor tools'))
  const edit = await run('Edit', {
    file_path: file,
    old_string: 'hello vendor tools',
    new_string: 'edited by vendor pipeline',
  })
  check('Edit ok', !edit.isError, edit.content.slice(0, 80))
  check('Edit applied on disk', readFileSync(file, 'utf8').includes('edited by vendor pipeline'))

  // 5. TodoWrite
  const todo = await run('TodoWrite', {
    todos: [
      { content: 'smoke item', status: 'in_progress', activeForm: 'Smoking' },
    ],
  })
  check('TodoWrite ok', !todo.isError, todo.content.slice(0, 80))

  // 5b. Skills — tool present, catalog prompt builds, safe unknown-skill path
  //     (exercises getCommands + getSkillToolCommands without crashing).
  check('Skill tool present', tools.some(t => t.name === 'Skill'))
  const skillApi = apiTools.find(t => t.name === 'Skill')
  check(
    'Skill catalog prompt builds',
    !!skillApi && /skill/i.test(skillApi.description),
    `len=${skillApi?.description.length}`,
  )
  const badSkill = await run('Skill', { skill: '__nope__' })
  check(
    'Skill unknown-name handled',
    badSkill.isError && /unknown skill/i.test(badSkill.content),
    badSkill.content.split('\n')[0],
  )

  // 6. Shell tools (PowerShell on win32, Bash if usable)
  const shellName = tools.some(t => t.name === 'PowerShell') ? 'PowerShell' : 'Bash'
  const shell = await run(shellName, { command: 'echo vendor-smoke-ok' })
  check(
    `${shellName} echo`,
    !shell.isError && shell.content.includes('vendor-smoke-ok'),
    shell.content.slice(0, 120).replace(/\n/g, ' | '),
  )
  if (shellName === 'PowerShell') {
    const bash = await run('Bash', { command: 'echo bash-smoke-ok' })
    // Bash may legitimately fail if no bash.exe; report either way.
    console.log(`INFO  Bash tool: isError=${bash.isError} — ${bash.content.slice(0, 120).replace(/\n/g, ' | ')}`)
  }

  // 7. Vendor system prompt
  try {
    const { getSystemPrompt } = await import('../src/vendor/leaked/constants/prompts.js')
    const sections = await getSystemPrompt(tools, MODEL)
    const prompt = sections.filter(Boolean).join('\n\n')
    check('vendor system prompt builds', prompt.length > 2000, `len=${prompt.length}`)
    console.log('--- prompt head ---')
    console.log(prompt.slice(0, 400))
    console.log('--- prompt sections:', sections.length, '---')
  } catch (err) {
    check('vendor system prompt builds', false, err instanceof Error ? err.message : String(err))
  }

  // 8. Compaction — threshold logic + summary flow with a stub adapter
  //    (no live provider in the harness).
  const bigHistory: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(40_000),
  }))
  check('shouldCompact triggers on large history', shouldCompact(bigHistory, 1_000))
  check('shouldCompact skips small history', !shouldCompact([{ role: 'user', content: 'hi' }]))
  const stubAdapter: LLMAdapter = {
    providerId: 'stub',
    providerName: 'stub',
    async stream() {},
    async complete() {
      return {
        role: 'assistant',
        content:
          '<analysis>scratchpad</analysis>\n<summary>Condensed summary of the prior turns.</summary>',
      }
    },
  }
  const compacted = await compactMessages({
    messages: bigHistory,
    adapter: stubAdapter,
    model: MODEL,
    maxTokens: 8_000,
  })
  check(
    'compaction returns one summary message',
    compacted.length === 1 &&
      typeof compacted[0].content === 'string' &&
      compacted[0].content.includes('Condensed summary of the prior turns'),
    `len=${compacted.length}`,
  )

  // 9. MCP manager — loads the SDK, no-crash with no servers configured,
  //    graceful unknown-tool handling (a live server isn't available here).
  check('MCP config loads (empty ok)', typeof loadConfig().mcpServers === 'object')
  await ensureConnected()
  check('MCP tools list is an array', Array.isArray(getMcpTools()))
  check('isMcpToolName detects mcp__ prefix', isMcpToolName('mcp__x__y') && !isMcpToolName('Bash'))
  const badMcp = await callMcpTool('mcp__nope__nope', {})
  check('MCP unknown-tool handled', badMcp.isError && /unknown mcp tool/i.test(badMcp.content))

  // 10. Sub-agents — Task tool present + runs the sub-agent path. No live
  //     provider in the harness, so it returns the graceful no-provider report.
  check('Task tool present', tools.some(t => t.name === 'Task'))
  check(
    'Task excluded from its own schema recursion guard',
    apiTools.some(t => t.name === 'Task'),
  )
  const task = await run('Task', { description: 'smoke', prompt: 'noop' })
  check(
    'Task sub-agent path runs',
    /no active provider|sub-agent/i.test(task.content),
    task.content.split('\n')[0],
  )

  // 11. Web tools — present + schemas + graceful invalid-URL (no network).
  check('WebFetch + WebSearch present', tools.some(t => t.name === 'WebFetch') && tools.some(t => t.name === 'WebSearch'))
  const wfApi = apiTools.find(t => t.name === 'WebFetch')
  const wsApi = apiTools.find(t => t.name === 'WebSearch')
  check('WebFetch schema has url', !!wfApi && 'url' in (wfApi.input_schema.properties ?? {}))
  check('WebSearch schema has query', !!wsApi && 'query' in (wsApi.input_schema.properties ?? {}))
  const badUrl = await run('WebFetch', { url: 'notaurl' })
  check('WebFetch rejects bad URL', badUrl.isError && /invalid url/i.test(badUrl.content))

  // ── Connectors ─────────────────────────────────────────────────────────
  // Scoping is what a routine relies on to stay inside its declared services,
  // and it's pure logic over the presets — cheap to pin down here.
  const { connectorToolNames, CONNECTOR_TOOL_NAMES } = await import(
    '../src/main/agent/connector-tools.js'
  )
  const names = (ids: string[]) => [...connectorToolNames(ids)].sort().join(',')

  check('connector scope: gmail → Mail only', names(['gmail']) === 'Mail')
  check(
    'connector scope: yandex-disk → CloudFiles only',
    names(['yandex-disk']) === 'CloudFiles',
  )
  // Drive speaks REST, not WebDAV, but serves the same tool — a routine scoped
  // to it must still get CloudFiles.
  check(
    'connector scope: google-drive → CloudFiles',
    names(['google-drive']) === 'CloudFiles',
  )
  check(
    'connector scope: calendar presets → Calendar',
    names(['google-calendar', 'yandex-contacts']) === 'Calendar',
  )
  // Google Contacts moved off CardDAV to the People API; it must still land on
  // the same tool, or a routine scoped to it would silently get nothing.
  check(
    'connector scope: google-contacts (People API) → Calendar',
    names(['google-contacts']) === 'Calendar',
  )
  check(
    'connector scope: gmail+telegram → both, nothing else',
    names(['gmail', 'telegram']) === 'Mail,Telegram',
  )
  // An MCP-backed connector must NOT pull in a protocol tool — it's scoped by
  // server name instead. Getting this wrong would hand a Notion routine the
  // user's mailbox.
  check('connector scope: notion (MCP) → no protocol tools', names(['notion']) === '')
  check('connector scope: unknown id → nothing', names(['nope']) === '')
  check(
    'connector tool names cover all four',
    ['Mail', 'CloudFiles', 'Calendar', 'Telegram'].every(n =>
      CONNECTOR_TOOL_NAMES.has(n),
    ),
  )

  // ── CreateRoutine ──────────────────────────────────────────────────────
  // A routine is a standing grant that runs with tools pre-approved, so the
  // guards matter more than the happy path.
  check('CreateRoutine tool present', tools.some(t => t.name === 'CreateRoutine'))

  const unattended = await run(
    'CreateRoutine',
    { name: 'x', prompt: 'y', trigger: 'schedule', cron: '0 9 * * *' },
    { unattended: true },
  )
  check(
    'CreateRoutine refuses to self-replicate in an unattended run',
    unattended.isError && /can't create routines/i.test(unattended.content),
  )

  // The regression that shipped: "Skip all approvals" is bypassPermissions too,
  // so keying the guard off the permission mode refused a user their own
  // routine while they sat watching. Attended means attended, whatever the mode.
  const skipAll = await run(
    'CreateRoutine',
    { name: 'x', prompt: 'y', trigger: 'schedule', cron: 'nonsense' },
    { permissionMode: 'bypassPermissions' },
  )
  check(
    'CreateRoutine still works for a user with Skip all approvals on',
    skipAll.isError && !/can't create routines/i.test(skipAll.content),
    skipAll.content.slice(0, 60),
  )

  const badCron = await run('CreateRoutine', {
    name: 'x',
    prompt: 'y',
    trigger: 'schedule',
    cron: 'not a cron',
  }, { permissionMode: 'default' })
  check('CreateRoutine rejects an unparseable cron', badCron.isError)

  const neverFires = await run('CreateRoutine', {
    name: 'x',
    prompt: 'y',
    trigger: 'schedule',
    cron: '0 0 30 2 *', // parses, but Feb 30 never comes
  }, { permissionMode: 'default' })
  check(
    'CreateRoutine rejects a cron that never fires',
    neverFires.isError && /never comes round/i.test(neverFires.content),
  )

  const ghost = await run('CreateRoutine', {
    name: 'x',
    prompt: 'y',
    trigger: 'schedule',
    cron: '0 9 * * *',
    connectors: ['not-a-connector'],
  }, { permissionMode: 'default' })
  check(
    'CreateRoutine rejects an unknown connector',
    ghost.isError && /not connected/i.test(ghost.content),
  )

  const noCron = await run('CreateRoutine', {
    name: 'x',
    prompt: 'y',
    trigger: 'schedule',
  }, { permissionMode: 'default' })
  check('CreateRoutine requires cron for a schedule', noCron.isError)

  // Every service must be honest about itself. These checks exist because a
  // guessed catalog once shipped fake endpoints, a missing Test branch showed
  // "works" for a never-contacted connector, and names drifted from the spec.
  const { SERVICES } = await import('../src/main/connectors/services/registry.js')
  const NAME_FOR: Record<string, string> = {
    gmail: 'GoogleGmail',
    'google-calendar': 'GoogleCalendar',
    'google-contacts': 'GoogleContacts',
    'google-drive': 'GoogleDrive',
    'yandex-mail': 'YandexMail',
    'yandex-disk': 'YandexDisk',
    'yandex-calendar': 'YandexCalendar',
    'yandex-contacts': 'YandexContacts',
    telegram: 'Telegram',
    github: 'GitHub',
    notion: 'Notion',
    slack: 'Slack',
    linear: 'Linear',
    sentry: 'Sentry',
  }
  const badName = SERVICES.filter(sv => NAME_FOR[sv.id] && sv.name !== NAME_FOR[sv.id])
  check(
    'service names are company-prefixed as specified',
    badName.length === 0,
    badName.map(sv => `${sv.id}→${sv.name}`).join(',') || undefined,
  )
  const noTest = SERVICES.filter(sv => typeof sv.test !== 'function')
  check('every service carries a test', noTest.length === 0, noTest.map(sv => sv.id).join(',') || undefined)
  const noCred = SERVICES.filter(sv => sv.auth.kind !== 'unavailable' && !sv.credUrl)
  check(
    'every connectable service links where to get its credential',
    noCred.length === 0,
    noCred.map(sv => sv.id).join(',') || undefined,
  )
  const noCaps = SERVICES.filter(
    sv => sv.auth.kind !== 'unavailable' && Object.keys(sv.capabilities).length === 0,
  )
  check(
    'every connectable service declares a capability',
    noCaps.length === 0,
    noCaps.map(sv => sv.id).join(',') || undefined,
  )
  const badOauth = SERVICES.filter(
    sv => sv.auth.kind === 'google-oauth' && sv.auth.scopes.length === 0,
  )
  check('every OAuth service declares scopes', badOauth.length === 0)
  const badIcon = SERVICES.filter(sv => sv.iconSvg && !sv.iconSvg.includes('<svg'))
  check('every icon is inline SVG', badIcon.length === 0)

  rmSync(dir, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('SMOKE CRASH:', err)
  process.exit(2)
})

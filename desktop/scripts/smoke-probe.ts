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

const MODEL = 'claude-opus-4-8'
let failures = 0

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function run(name: string, input: Record<string, unknown>) {
  return executeVendorTool({
    sessionId: 'smoke',
    toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
    name,
    input,
    model: MODEL,
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

  rmSync(dir, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('SMOKE CRASH:', err)
  process.exit(2)
})

/**
 * Runtime smoke for the vendor tool pipeline — runs under plain Node (no
 * Electron): lists tools, converts schemas, greps the repo, writes+reads a
 * temp file, runs a shell command, and builds the vendor system prompt.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  executeVendorTool,
  getVendorApiTools,
  getVendorTools,
  getVendorToolsForSpace,
} from '../src/main/agent/vendor-tools.js'
import { initVendorRuntime } from '../src/main/agent/vendor-context.js'
import { getWorkspacePath } from '../src/main/ipc/workspace.js'
import { shouldCompact, compactMessages } from '../src/main/agent/compaction.js'
import { microCompact } from '../src/main/agent/microcompact.js'
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
  sessionId = 'smoke',
) {
  const mode = opts?.permissionMode ?? 'bypassPermissions'
  return executeVendorTool({
    sessionId,
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
    path: 'src/main/engine/constants',
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

  // 4b. Auto mode: writes are scoped to the workspace, not allowed by name.
  // A file inside the workspace runs silently; the same tool aimed outside it
  // must still reach the user. Fresh sessionId per call so an "allow always"
  // grant from one check can't leak into the next.
  const runAuto = async (name: string, input: Record<string, unknown>) => {
    let asked = false
    const res = await executeVendorTool({
      sessionId: `smoke-auto-${Math.random().toString(36).slice(2)}`,
      toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
      name,
      input,
      model: MODEL,
      permissionMode: 'auto',
      requestPermission: async () => {
        asked = true
        return { behavior: 'allow' as const }
      },
    })
    return { asked, res }
  }

  const inside = join(getWorkspacePath(), '.smoke-auto-inside.txt')
  const insideWrite = await runAuto('Write', { file_path: inside, content: 'in workspace\n' })
  check('auto: write inside the workspace does not prompt', !insideWrite.asked, insideWrite.res.content.slice(0, 60))
  rmSync(inside, { force: true })

  const outsideWrite = await runAuto('Write', {
    file_path: join(dir, 'outside.txt'),
    content: 'outside workspace\n',
  })
  check('auto: write OUTSIDE the workspace still prompts', outsideWrite.asked)

  const autoRead = await runAuto('Read', { file_path: file })
  check('auto: read does not prompt', !autoRead.asked)

  // Bash is not blanket-prompted: the vendor's own rules already rate
  // `echo`/`git status` as safe and only escalate risky shapes. Auto mode
  // inherits both halves of that judgement.
  const safeBash = await runAuto('Bash', { command: 'echo hi', description: 'echo' })
  check('auto: a safe Bash command does not prompt', !safeBash.asked)

  const riskyBash = await runAuto('Bash', {
    command: 'rm -rf /tmp/definitely-not-real',
    description: 'rm',
  })
  check('auto: a risky Bash command still prompts', riskyBash.asked)

  // 4c. Hooks — configured in <dataDir>/hooks.json (this app does not read
  // ~/.claude), and a repo's own .claude/settings.json must NOT be honoured:
  // a cloned project could otherwise run any shell command via PreToolUse.
  {
    const { hooksFilePath, hooksAvailable, reloadHooks } = await import(
      '../src/main/agent/tool-hooks.js'
    )
    const hookFile = hooksFilePath()
    const hadHooks = existsSync(hookFile)
    const savedHooks = hadHooks ? readFileSync(hookFile, 'utf8') : null
    const projectSettings = join(getWorkspacePath(), '.claude', 'settings.json')
    const hadProject = existsSync(projectSettings)
    const savedProject = hadProject ? readFileSync(projectSettings, 'utf8') : null
    const blockHook = (tag: string) => ({
      PreToolUse: [
        {
          matcher: 'Glob',
          // Hook commands run under bash on every platform (Git Bash on
          // Windows) — cmd syntax would silently no-op.
          hooks: [{ type: 'command', command: `echo ${tag} >&2; exit 2` }],
        },
      ],
    })
    try {
      writeFileSync(hookFile, JSON.stringify({ hooks: blockHook('blocked-by-datadir-hook') }))
      const loaded = await reloadHooks()
      check('hooks: loaded from dataDir/hooks.json', loaded.events === 1 && (await hooksAvailable()), JSON.stringify(loaded))

      const blocked = await run('Glob', { pattern: 'src/main/*.ts' })
      check(
        'hooks: PreToolUse exit-2 blocks the tool',
        blocked.isError && /blocked-by-datadir-hook/.test(blocked.content),
        blocked.content.slice(0, 80).replace(/\n/g, ' | '),
      )
      const unaffected = await run('Grep', {
        pattern: 'export',
        path: 'src/main/agent',
        output_mode: 'files_with_matches',
      })
      check('hooks: a non-matching tool is unaffected', !unaffected.isError)

      // Reloading twice must not double-register (registerHookCallbacks merges).
      await reloadHooks()
      await reloadHooks()
      const { listConfiguredHooks } = await import('../src/main/agent/tool-hooks.js')
      const listed = await listConfiguredHooks()
      check('hooks: reload does not duplicate registrations', listed.length === 1, `${listed.length} matchers`)

      // Now the security property: a repo-supplied hook must be ignored.
      rmSync(hookFile, { force: true })
      mkdirSync(join(getWorkspacePath(), '.claude'), { recursive: true })
      writeFileSync(projectSettings, JSON.stringify(blockHook('blocked-by-repo-hook')))
      await reloadHooks()
      const repoHooked = await run('Glob', { pattern: 'src/main/*.ts' })
      check(
        'hooks: a repo .claude/settings.json hook is NOT executed',
        !repoHooked.isError && !/blocked-by-repo-hook/.test(repoHooked.content),
        repoHooked.content.slice(0, 60).replace(/\n/g, ' | '),
      )
    } finally {
      if (savedHooks !== null) writeFileSync(hookFile, savedHooks)
      else rmSync(hookFile, { force: true })
      if (savedProject !== null) writeFileSync(projectSettings, savedProject)
      else rmSync(projectSettings, { force: true })
      await reloadHooks()
    }
  }

  // 4d. Plan approval — ExitPlanMode must reach the user, report the verdict,
  // and an approval must unblock the REST of the same turn (plan mode blocks
  // writes, so the model would otherwise be told "start work" and immediately
  // hit a wall).
  {
    const { clearSessionMode } = await import('../src/main/agent/session-mode.js')
    const { deletePlans } = await import('../src/main/plan/store.js')
    const planFile = join(getWorkspacePath(), '.smoke-plan.txt')
    const runPlan = async (
      session: string,
      decision: 'approve' | 'approve-auto' | 'keep-planning',
      feedback?: string,
    ) => {
      let shown: string | null = null
      const res = await executeVendorTool({
        sessionId: session,
        toolUseID: `toolu_${Math.random().toString(36).slice(2)}`,
        name: 'ExitPlanMode',
        input: {
          title: 'Smoke plan',
          plan: '## Plan\n1. Do the thing',
          todos: ['Do the thing'],
        },
        model: MODEL,
        permissionMode: 'plan',
        askPlanApproval: async (plan: string) => {
          shown = plan
          return { decision, feedback }
        },
      })
      return { shown, res }
    }

    const kept = await runPlan('plan-keep', 'keep-planning', 'add tests first')
    check('plan: the plan reaches the user', (kept.shown ?? '').includes('Do the thing'))
    check(
      'plan: rejection returns the feedback to the model',
      /add tests first/.test(kept.res.content) && /[Dd]o not start/.test(kept.res.content),
      kept.res.content.slice(0, 70).replace(/\n/g, ' | '),
    )

    // Before approval, plan mode blocks a write.
    const beforeSession = 'plan-approve'
    clearSessionMode(beforeSession)
    const blockedWrite = await executeVendorTool({
      sessionId: beforeSession,
      toolUseID: 'toolu_planblock',
      name: 'Write',
      input: { file_path: planFile, content: 'x' },
      model: MODEL,
      permissionMode: 'plan',
    })
    check('plan: writes are blocked before approval', blockedWrite.isError && /[Pp]lan mode/.test(blockedWrite.content))

    const approved = await runPlan(beforeSession, 'approve')
    check('plan: approval tells the model to start', /[Ss]tart working/.test(approved.res.content))

    // Same session, same requested mode: the override must now let it through.
    const afterWrite = await executeVendorTool({
      sessionId: beforeSession,
      toolUseID: 'toolu_planafter',
      name: 'Write',
      input: { file_path: planFile, content: 'approved\n' },
      model: MODEL,
      permissionMode: 'plan',
      requestPermission: async () => ({ behavior: 'allow' as const }),
    })
    check('plan: approval unblocks the rest of the turn', !afterWrite.isError, afterWrite.content.slice(0, 60))
    rmSync(planFile, { force: true })

    // A different session must NOT inherit that approval.
    const otherBlocked = await executeVendorTool({
      sessionId: 'plan-other',
      toolUseID: 'toolu_planother',
      name: 'Write',
      input: { file_path: planFile, content: 'x' },
      model: MODEL,
      permissionMode: 'plan',
    })
    check('plan: approval does not leak to another session', otherBlocked.isError)
    clearSessionMode(beforeSession)
    rmSync(planFile, { force: true })
    // The tool now writes real plan documents — these sids are fakes, so
    // their rows must not linger in the data dir's DB.
    deletePlans('plan-keep')
    deletePlans(beforeSession)

    // 4d2. EnterPlanMode — the model switches itself into plan mode when the
    // user asks for a plan in prose. The override must bind to the selector
    // value it was set under, and die the moment the user flips it.
    const enterSid = 'plan-enter'
    clearSessionMode(enterSid)
    const entered = await executeVendorTool({
      sessionId: enterSid,
      toolUseID: 'toolu_enter',
      name: 'EnterPlanMode',
      input: {},
      model: MODEL,
      permissionMode: 'default',
    })
    check(
      'enter-plan: the tool reports the switch',
      !entered.isError && /[Pp]lan mode is on/.test(entered.content),
      entered.content.slice(0, 60),
    )
    const enterBlocked = await executeVendorTool({
      sessionId: enterSid,
      toolUseID: 'toolu_enterblock',
      name: 'Write',
      input: { file_path: planFile, content: 'x' },
      model: MODEL,
      permissionMode: 'default',
    })
    check(
      'enter-plan: writes are blocked though the selector still says default',
      enterBlocked.isError && /[Pp]lan [Mm]ode/.test(enterBlocked.content),
      enterBlocked.content.slice(0, 60),
    )
    const { effectiveMode } = await import('../src/main/agent/session-mode.js')
    check(
      'enter-plan: flipping the selector drops the override',
      effectiveMode(enterSid, 'acceptEdits') === 'acceptEdits',
    )
    clearSessionMode(enterSid)

    // 4d3. Serving a page from Home. The real gate (isSpaceToolAllowed) is
    // what decides, so it is asked here rather than through the space list:
    // DevServer runs on the HOST in the Code workspace, and in a Home chat
    // that meant serving the app's own project root to the network.
    const { setSessionEngine, clearSessionEngine } = await import(
      '../src/main/sandbox/config.js'
    )
    const serveSid = 'serve-gate'
    const names = (space: string, sid: string): string[] =>
      getVendorToolsForSpace(space, sid).map((t) => t.name)

    clearSessionEngine(serveSid)
    // In Code it depends only on the browser setting — which is what the
    // gate said before Home was carved out of it, and must still say. The
    // setting is turned ON for the check: with the browser off, DevServer is
    // absent everywhere and "Home cannot reach it" would prove nothing.
    const { getBrowserConfig, setBrowserConfig } = await import(
      '../src/main/browser/config.js'
    )
    const browserWas = getBrowserConfig().enabled
    setBrowserConfig({ enabled: true })
    check(
      'serve: with the browser ON, Code has DevServer',
      names('code', serveSid).includes('DevServer'),
    )
    check(
      'serve: and Home still cannot reach it',
      !names('home', serveSid).includes('DevServer'),
    )
    setBrowserConfig({ enabled: browserWas })
    check(
      'serve: no sandbox server without the container engine',
      !names('home', serveSid).includes('ServeSandbox'),
    )
    setSessionEngine(serveSid, 'docker')
    check(
      'serve: Podman Home gets ServeSandbox',
      names('home', serveSid).includes('ServeSandbox'),
    )
    check(
      'serve: and Code never does (it has a workspace)',
      !names('code', serveSid).includes('ServeSandbox'),
    )
    clearSessionEngine(serveSid)
  }

  // 4d-bis. Read/Write/Edit/Glob mean the sandbox in Home and the disk in
  // Code — same names, different implementations. Which one a session gets is
  // decided from its database row; that half is checked in
  // session-space-probe.ts, which runs on the harness that can open the DB.
  // Here: that the swap happens at all, and that no Sandbox* name survives.
  {
    const { getVendorToolsForSpace } = await import(
      '../src/main/agent/vendor-tools.js'
    )
    const home = getVendorToolsForSpace('home')
    const code = getVendorToolsForSpace('code')
    const find = (ts: { name: string }[], n: string) => ts.find(t => t.name === n)
    const sandboxy = (t: { searchHint?: string } | undefined) =>
      /sandbox/i.test(t?.searchHint ?? '')

    for (const n of ['Read', 'Write', 'Edit', 'Glob'])
      check(`${n} exists in both spaces`, !!find(home, n) && !!find(code, n))
    check('Home Read is the sandbox one', sandboxy(find(home, 'Read')))
    check('Code Read is the disk one', !sandboxy(find(code, 'Read')))
    check('Home Write is the sandbox one', sandboxy(find(home, 'Write')))
    check('Code Write is the disk one', !sandboxy(find(code, 'Write')))
    check(
      'no Sandbox* file tool is advertised any more',
      ![...home, ...code].some(t =>
        /^Sandbox(Read|Write|Edit|List)$/.test(t.name),
      ),
    )
    check('one Read, not two', home.filter(t => t.name === 'Read').length === 1)
  }

  // 4e. The shell surface is ONE tool, and waiting is not a tool at all.
  //
  // Sleep, RunCommandBackground and BackgroundOutput were four names for one
  // verb, and the model burned turns choosing between them — Sleep 20, check,
  // Sleep 30, check. A background command now returns at once and announces
  // its own finish, so there is nothing left to wait for. These assertions
  // are the guard against any of them creeping back.
  {
    const gone = ['Sleep', 'RunCommandBackground', 'BackgroundOutput']
    for (const name of gone)
      check(`${name} is gone`, !tools.some(t => t.name === name))
    check('RunCommand is the only way to run a command', tools.some(t => t.name === 'RunCommand'))
    const runCommand = tools.find(t => t.name === 'RunCommand')
    const shape = runCommand ? JSON.stringify(runCommand.inputSchema ?? {}) : ''
    check('…and it takes run_in_background', /run_in_background/.test(shape))
    check('NotebookEdit tool present', tools.some(t => t.name === 'NotebookEdit'))

    // NotebookEdit on a real notebook.
    const nb = join(dir, 'smoke.ipynb')
    writeFileSync(
      nb,
      JSON.stringify({
        cells: [
          { id: 'c1', cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
    // Read-before-write is enforced for notebooks too, same as Edit.
    const nbBlind = await run('NotebookEdit', {
      notebook_path: nb,
      cell_id: 'c1',
      new_source: 'print(0)',
    })
    check(
      'NotebookEdit refuses a blind edit',
      nbBlind.isError && /read/i.test(nbBlind.content),
      nbBlind.content.slice(0, 60),
    )

    await run('Read', { file_path: nb })
    const nbEdit = await run('NotebookEdit', {
      notebook_path: nb,
      cell_id: 'c1',
      new_source: 'print(42)',
    })
    const nbAfter = readFileSync(nb, 'utf8')
    check(
      'NotebookEdit rewrites a cell',
      !nbEdit.isError && nbAfter.includes('print(42)'),
      nbEdit.content.slice(0, 70).replace(/\n/g, ' | '),
    )
  }

  // 4f. Team — background agents are addressable: named, listable, messageable.
  {
    const {
      registerBgAgent,
      unregisterBgAgent,
      listTeam,
      sendToMember,
      drainInbox,
      stopMember,
      pushBgResult,
      collectBgReports,
      pendingReportCount,
      drainBgResults,
    } = await import('../src/main/agent/bg-agents.js')
    const sid = 'smoke-team'
    const c1 = new AbortController()
    const c2 = new AbortController()
    const n1 = registerBgAgent(sid, c1, { agentType: 'Explore', description: 'find X' })
    const n2 = registerBgAgent(sid, c2, { agentType: 'Explore', description: 'find Y' })
    check('team: names are unique per session', n1 === 'explore' && n2 === 'explore-2', `${n1}, ${n2}`)
    check('team: both are listed', listTeam(sid).length === 2)

    check('team: message to a known name is delivered', sendToMember(sid, n1, 'main', 'skip vendor/'))
    check('team: message to an unknown name fails', !sendToMember(sid, 'nobody', 'main', 'hi'))
    const inbox = drainInbox(sid, n1)
    check('team: recipient drains its inbox', inbox.length === 1 && inbox[0].includes('skip vendor/'), inbox[0]?.slice(0, 40))
    check('team: draining empties it', drainInbox(sid, n1).length === 0)
    check('team: the other agent got nothing', drainInbox(sid, n2).length === 0)

    check('team: stop removes a member and aborts it', stopMember(sid, n2) && c2.signal.aborted && listTeam(sid).length === 1)
    check('team: stopping an unknown name fails', !stopMember(sid, 'nobody'))

    // Finishing deregisters, so a finished agent is no longer addressable.
    unregisterBgAgent(sid, c1)
    check('team: a finished agent leaves the roster', listTeam(sid).length === 0)
    check('team: messaging a finished agent fails', !sendToMember(sid, n1, 'main', 'late'))

    check('SendMessage tool present', tools.some(t => t.name === 'SendMessage'))
    check('TeamList tool present', tools.some(t => t.name === 'TeamList'))
    const emptyList = await run('TeamList', {})
    check('TeamList reports an empty team', !emptyList.isError && /No background agents/.test(emptyList.content))
    const badSend = await run('SendMessage', { to: 'ghost', message: 'hi' })
    check('SendMessage to a missing agent errors', badSend.isError && /No running agent/.test(badSend.content))

    // Report collection — the fix for the Sleep-loop swarm. A finished agent's
    // report reaches the model through TeamList, not only at the next turn.
    const rsid = 'smoke-reports'
    const rc = new AbortController()
    const rn = registerBgAgent(rsid, rc, { agentType: 'Explore', description: 'scan' })
    pushBgResult(rsid, 'Explore', 'scan', 'found 3 things', rn)
    check('reports: TeamList surfaces a finished report', /found 3 things/.test((await run('TeamList', {}, undefined, rsid)).content))
    check('reports: collecting drains the queue', pendingReportCount(rsid) === 0)
    unregisterBgAgent(rsid, rc)

    // A report collected by TeamList must NOT also arrive at the turn boundary.
    pushBgResult(rsid, 'Explore', 'scan', 'second finding', 'explore')
    collectBgReports(rsid)
    check('reports: a collected report is not re-delivered at the turn boundary', drainBgResults(rsid).length === 0)

    // wait returns promptly once a report exists, rather than blocking.
    const wsid = 'smoke-wait'
    const wc = new AbortController()
    registerBgAgent(wsid, wc, { agentType: 'Explore', description: 'w' })
    pushBgResult(wsid, 'Explore', 'w', 'ready', 'explore')
    const t0 = Date.now()
    const waited = await run('TeamList', { wait: true }, undefined, wsid)
    check('reports: wait returns at once when a report is ready', Date.now() - t0 < 1_000 && /ready/.test(waited.content), `${Date.now() - t0}ms`)
    unregisterBgAgent(wsid, wc)
    check('reports: wait with nothing running returns immediately', (await run('TeamList', { wait: true }, undefined, 'smoke-idle')).content.length > 0)
  }

  // 4f. Non-zero exit must surface output, not swallow it. A red pytest, a
  // grep with no match, a diff with differences all exit non-zero legitimately
  // — BashTool throws ShellError and the executor must show its output.
  {
    const failing = await run('Bash', {
      command: 'echo on-stdout; echo on-stderr >&2; exit 3',
      description: 'non-zero exit',
    })
    // Both halves matter. The exit code tells the model the command failed;
    // the OUTPUT tells it why. The output used to be erased because BashTool
    // routes it through SandboxManager.annotateStderrWithSandboxFailures(),
    // and the blanket package stub returned undefined for every call.
    check(
      'Bash: a non-zero exit reports the exit code',
      failing.isError && /exit code 3/i.test(failing.content),
      failing.content.slice(0, 70).replace(/\n/g, ' | '),
    )
    check(
      'Bash: a non-zero exit keeps the command output',
      /on-stdout/.test(failing.content) && /on-stderr/.test(failing.content),
      failing.content.slice(0, 90).replace(/\n/g, ' | '),
    )
  }

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
    const { getSystemPrompt } = await import('@main/engine/constants/prompts.js')
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
  // Mark the last exchanges so we can prove they survive verbatim.
  const tailMarked = [...bigHistory]
  tailMarked[18] = { role: 'user', content: 'KEEP-ME-VERBATIM last request' }
  tailMarked[19] = { role: 'assistant', content: 'KEEP-ME-TOO the reply' }
  const compacted = await compactMessages({
    messages: tailMarked,
    adapter: stubAdapter,
    model: MODEL,
    maxTokens: 8_000,
  })
  const asText = (m: LLMMessage) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  check(
    'compaction summarises the old part',
    !!compacted.header &&
      typeof compacted.header.content === 'string' &&
      compacted.header.content.includes('Condensed summary of the prior turns'),
    `folded=${compacted.folded.length}`,
  )
  check(
    'compaction keeps the recent turns VERBATIM',
    compacted.messages.some(m => asText(m).includes('KEEP-ME-VERBATIM last request')) &&
      compacted.messages.some(m => asText(m).includes('KEEP-ME-TOO the reply')),
  )
  // Nothing is deleted: the summary stands in front of the turns it replaces
  // and the caller takes THOSE out of context. That is what makes a compaction
  // undoable without storing a copy of the conversation — see undoCompaction.
  check(
    'compaction names what the summary stands for, and deletes nothing',
    compacted.folded.length > 0 &&
      tailMarked.every(m => compacted.messages.includes(m)),
    { folded: compacted.folded.length, kept: compacted.messages.length },
  )
  check(
    'what it stands for does not include the verbatim tail',
    !compacted.folded.some(m => asText(m).includes('KEEP-ME-VERBATIM')),
  )

  // 8b. Micro-compaction — lossless pass over replayable tool output.
  const withTools: LLMMessage[] = [
    { role: 'user', content: 'read some files' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 'tu_ask', name: 'AskUserQuestion', input: {} },
        { type: 'tool_use', id: 'tu_err', name: 'Bash', input: { command: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_read', content: 'F'.repeat(5_000) },
        { type: 'tool_result', tool_use_id: 'tu_ask', content: 'A'.repeat(5_000) },
        { type: 'tool_result', tool_use_id: 'tu_err', content: 'E'.repeat(5_000), is_error: true },
      ],
    },
    ...Array.from({ length: 8 }, (_, i): LLMMessage => ({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `filler ${i}`,
    })),
  ]
  const micro = microCompact(withTools)
  const microText = micro.messages.map(asText).join('\n')
  check('micro: clears a replayable tool result', !microText.includes('F'.repeat(5_000)) && micro.cleared === 1, `cleared=${micro.cleared}`)
  check('micro: keeps a NON-replayable tool result', microText.includes('A'.repeat(5_000)))
  check('micro: keeps an error result', microText.includes('E'.repeat(5_000)))
  check('micro: reports the saving', micro.charsSaved > 4_000, `${micro.charsSaved} chars`)
  check(
    'micro: leaves what was SAID untouched',
    microText.includes('read some files') && microText.includes('filler 7'),
  )

  // Recent tool results are protected even when replayable.
  const recentOnly: LLMMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_r', content: 'R'.repeat(5_000) }] },
  ]
  check('micro: recent results are protected', microCompact(recentOnly).cleared === 0)

  // When the lossless pass alone gets under the threshold, no summary is made.
  let summaryCalls = 0
  const countingAdapter: LLMAdapter = {
    ...stubAdapter,
    async complete() {
      summaryCalls++
      return { role: 'assistant', content: '<summary>should not happen</summary>' }
    },
  }
  // ~10k chars survive the clear (the non-replayable + error results), so a
  // 4k-token budget fits and a 100-token one cannot.
  const fitsAfterMicro = await compactMessages({
    messages: withTools,
    adapter: countingAdapter,
    model: MODEL,
    maxTokens: 8_000,
    threshold: 4_000,
  })
  check(
    'compaction skips the model call when clearing alone fits',
    summaryCalls === 0 &&
      fitsAfterMicro.header === null &&
      fitsAfterMicro.messages.length === withTools.length,
    `calls=${summaryCalls}`,
  )

  summaryCalls = 0
  await compactMessages({
    messages: withTools,
    adapter: countingAdapter,
    model: MODEL,
    maxTokens: 8_000,
    threshold: 100,
  })
  check(
    'compaction still summarises when clearing is not enough',
    summaryCalls === 1,
    `calls=${summaryCalls}`,
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
    names(['gmail', 'telegram-account']) === 'Mail,Telegram',
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
    'telegram-account': 'TelegramAccount',
    'telegram-bot': 'TelegramBot',
    github: 'GitHub',
    // notion, slack, linear, sentry moved to the store (monet-connectors repo)
  }
  const badName = SERVICES.filter(sv => NAME_FOR[sv.id] && sv.name !== NAME_FOR[sv.id])
  check(
    'service names are company-prefixed as specified',
    badName.length === 0,
    badName.map(sv => `${sv.id}→${sv.name}`).join(',') || undefined,
  )
  // Settings shows the human-friendly displayName; the compact name is what
  // the model, routines and the context meter use.
  const { displayNameOf } = await import('../src/main/connectors/services/types.js')
  const DISPLAY_FOR: Record<string, string> = {
    gmail: 'Google Gmail',
    'google-drive': 'Google Drive',
    'google-calendar': 'Google Calendar',
    'google-contacts': 'Google Contacts',
    'yandex-mail': 'Yandex Mail',
    'yandex-disk': 'Yandex Disk',
    'yandex-calendar': 'Yandex Calendar',
    'yandex-contacts': 'Yandex Contacts',
    github: 'GitHub',
    'telegram-account': 'Telegram Account',
    'telegram-bot': 'Telegram Bot',
  }
  const badDisplay = SERVICES.filter(
    sv => DISPLAY_FOR[sv.id] && displayNameOf(sv) !== DISPLAY_FOR[sv.id],
  )
  check(
    'settings display names are spaced by company',
    badDisplay.length === 0,
    badDisplay.map(sv => `${sv.id}→${displayNameOf(sv)}`).join(',') || undefined,
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

  // ── Connector action permissions ─────────────────────────────────────────
  {
    const types = await import('../src/main/connectors/services/types.js')
    const { CAPABILITY_ACTIONS, actionsForService, findAction } = types
    // Every capability a service declares must map to a non-empty action list —
    // an op without an action would dodge the permission engine entirely.
    const uncovered = SERVICES.filter(sv =>
      Object.keys(sv.capabilities).some(
        cap => !(CAPABILITY_ACTIONS as Record<string, unknown[]>)[cap]?.length,
      ),
    )
    check(
      'every capability has declared actions',
      uncovered.length === 0,
      uncovered.map(sv => sv.id).join(',') || undefined,
    )
    // The tool layer's action enums must agree with the declared action ids.
    for (const [cap, actions] of [
      ['mail', ['folders', 'search', 'read', 'send']],
      ['files', ['list', 'read', 'write', 'delete', 'mkdir']],
      ['calendar', ['calendars', 'events', 'create']],
      ['contacts', ['list']],
      ['chat', ['chats', 'topics', 'history', 'send', 'send_file']],
    ] as const) {
      const missing = actions.filter(a => !findAction(`${cap}.${a}`))
      check(
        `tool actions declared for ${cap}`,
        missing.length === 0,
        missing.join(',') || undefined,
      )
    }

    const { resolveActionLevel, gateConnectorAction } = await import(
      '../src/main/connectors/lib/permissions.js'
    )
    const fakeAcct = (permissions?: Record<string, 'allow' | 'ask' | 'deny'>) =>
      ({
        account: { id: 'a1', permissions },
        secret: {},
        service: SERVICES.find(sv => sv.id === 'gmail'),
      }) as never
    check(
      'permission defaults: read allows, write asks',
      resolveActionLevel(fakeAcct(), 'mail.search') === 'allow' &&
        resolveActionLevel(fakeAcct(), 'mail.send') === 'ask',
    )
    check(
      'permission override beats the default',
      resolveActionLevel(fakeAcct({ 'mail.send': 'deny' }), 'mail.send') === 'deny' &&
        resolveActionLevel(fakeAcct({ 'mail.search': 'deny' }), 'mail.search') === 'deny',
    )
    const denied = await gateConnectorAction(
      fakeAcct({ 'mail.send': 'deny' }),
      'mail.send',
      { summary: 'send' },
      { permissionMode: 'bypassPermissions' },
    )
    check('explicit deny survives bypassPermissions', !denied.ok)
    const unattendedAsk = await gateConnectorAction(
      fakeAcct(),
      'mail.send',
      { summary: 'send' },
      { unattended: true },
    )
    check('unattended denies ask-level actions', !unattendedAsk.ok)
    const granted = await gateConnectorAction(
      fakeAcct(),
      'mail.send',
      { summary: 'send' },
      { unattended: true, connectorGrants: ['mail.send'] },
    )
    check('a routine grant allows the granted action', granted.ok)
    const destructive = await gateConnectorAction(
      fakeAcct(),
      'files.delete',
      { summary: 'del' },
      { unattended: true, connectorGrants: ['files.delete'] },
    )
    check('destructive is never grantable unattended', !destructive.ok)
    const bypassed = await gateConnectorAction(
      fakeAcct(),
      'mail.send',
      { summary: 'send' },
      { permissionMode: 'bypassPermissions' },
    )
    check('bypassPermissions skips the ask', bypassed.ok)
    const autoDestructive = await gateConnectorAction(
      fakeAcct(),
      'files.delete',
      { summary: 'del' },
      { permissionMode: 'auto' },
    )
    check('auto mode still asks for destructive (no prompt channel → deny)', !autoDestructive.ok)
    // UI projection carries the matrix.
    const uiActs = SERVICES.map(sv => actionsForService(sv))
    check(
      'every connectable service exposes actions to the UI',
      SERVICES.every((sv, i) => Object.keys(sv.capabilities).length === 0 || uiActs[i].length > 0),
    )
  }

  // ── Store manifests (data → service, hostile input refused) ─────────────
  {
    const { manifestToService, MANIFEST_SCHEMA } = await import(
      '../src/main/connectors/services/manifest.js'
    )
    const { BUILTIN_IDS } = await import(
      '../src/main/connectors/services/registry.js'
    )
    const good = {
      schema: MANIFEST_SCHEMA,
      id: 'mailru',
      name: 'MailruMail',
      company: 'Mail.ru',
      description: 'Mail over IMAP/SMTP with an app password.',
      version: '1.0.0',
      auth: {
        kind: 'password',
        fields: [
          { key: 'username', label: 'Login' },
          { key: 'password', label: 'App password', secret: true },
        ],
      },
      capabilities: {
        mail: {
          imap: { host: 'imap.mail.ru', port: 993, secure: true },
          smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
        },
      },
    }
    const svc = manifestToService(good as never, { builtinIds: BUILTIN_IDS })
    check(
      'manifest → service (mail, derived test)',
      !!svc.capabilities.mail && typeof svc.test === 'function' && svc.id === 'mailru',
    )
    const rejects = (patch: object, name: string): void => {
      let threw = false
      try {
        manifestToService({ ...good, ...patch } as never, { builtinIds: BUILTIN_IDS })
      } catch {
        threw = true
      }
      check(name, threw)
    }
    rejects({ id: 'gmail' }, 'manifest refuses builtin id collision')
    rejects(
      { capabilities: { webdav: { url: 'http://insecure.example' } } },
      'manifest refuses non-https endpoints',
    )
    rejects(
      { capabilities: { mcp: { command: 'bash', args: [], envKey: 'X' } } },
      'manifest refuses non-allowlisted mcp commands',
    )
    rejects(
      {
        capabilities: {
          mail: {
            imap: { host: 'imap.mail.ru', port: 993, secure: false },
            smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
          },
        },
      },
      'manifest refuses plaintext mail hosts',
    )
    rejects(
      { auth: { kind: 'google-oauth', scopes: [] } },
      'manifest refuses code-requiring auth kinds',
    )
    rejects({ capabilities: {} }, 'manifest refuses zero capabilities')

    // Remote MCP (OAuth 2.1) — valid manifest builds a service with url.
    const remoteGood = {
      schema: MANIFEST_SCHEMA,
      id: 'dropbox-test',
      name: 'DropboxTest',
      company: 'Dropbox',
      description: 'Remote MCP via OAuth.',
      version: '1.0.0',
      auth: { kind: 'oauth-mcp' as const },
      capabilities: {
        mcp: { url: 'https://mcp.dropbox.com/mcp', transport: 'http' as const },
      },
    }
    const rsvc = manifestToService(remoteGood as never, {
      builtinIds: BUILTIN_IDS,
    })
    check(
      'manifest → service (remote mcp, oauth-mcp auth)',
      rsvc.auth.kind === 'oauth-mcp' &&
        'url' in (rsvc.capabilities.mcp ?? {}) &&
        typeof rsvc.test === 'function',
    )
    const rejectsRemote = (patch: object, name: string): void => {
      let threw = false
      try {
        manifestToService(
          { ...remoteGood, ...patch } as never,
          { builtinIds: BUILTIN_IDS },
        )
      } catch {
        threw = true
      }
      check(name, threw)
    }
    rejectsRemote(
      { capabilities: { mcp: { url: 'http://insecure.example/mcp' } } },
      'manifest refuses non-https remote mcp url',
    )
    rejectsRemote(
      { capabilities: { mcp: { url: 'https://x.example', transport: 'ws' as never } } },
      'manifest refuses unsupported mcp transport',
    )
  }

  // ── FileBridge (Home sandbox confinement) ────────────────────────────────
  {
    const { makeFileBridge } = await import(
      '../src/main/connectors/lib/file-bridge.js'
    )
    const bridge = makeFileBridge('smoke-bridge', 'home')
    try {
      const saved = await bridge.write('report.txt', Buffer.from('hello'))
      check('bridge write lands inside its root', saved.path.startsWith(bridge.root))
      check(
        'bridge write emits an artifact line',
        saved.artifactLine.startsWith('[artifact] text/plain report.txt :: '),
      )
      const again = await bridge.write('report.txt', Buffer.from('two'))
      check(
        'bridge write is collision-safe',
        again.path !== saved.path && again.path.includes('report (2)'),
      )
      check(
        'bridge resolves its own file for reading',
        bridge.resolveRead('report.txt') === saved.path,
      )
      let escaped = false
      try {
        bridge.resolveRead('../../outside.txt')
        escaped = true
      } catch {
        /* expected */
      }
      check('bridge refuses ../ traversal out of the sandbox', !escaped)
      let absEscaped = false
      try {
        bridge.resolveRead(join(tmpdir(), 'anything.txt'))
        absEscaped = true
      } catch {
        /* expected */
      }
      check('bridge refuses absolute paths outside the sandbox', !absEscaped)
      let oversize = false
      try {
        await bridge.write('big.bin', Buffer.alloc(64), { maxBytes: 16 })
        oversize = true
      } catch {
        /* expected */
      }
      check('bridge enforces the size cap', !oversize)
    } finally {
      rmSync(bridge.root, { recursive: true, force: true })
    }
  }

  // ── Context: which prompts the model still reads ───────────────────────
  //
  // The checks that used to live here drove the agent's conversation map
  // through `seedConversation`, a back door that existed for one reason: the
  // renderer sent a text-only rebuild of every chat on every send, and the
  // agent had to accept it. That path is gone (see ensureTranscriptLoaded),
  // and with it the only way to put messages into a conversation from outside
  // a real run.
  //
  // What it was pinning is pinned where it can still be exercised:
  //   - the arithmetic of "which messages does a prompt own" — turn-context-probe
  //   - identity and the context flag across a save — transcript-identity-probe
  //   - a compaction taking prompts out instead of deleting them —
  //     compaction-context-probe
  //   - the prompt COUNT the chat cuts by, notes included — retry-probe

  // ── Goal driver ────────────────────────────────────────────────────────
  // The driver is the loop that keeps taking turns on its own, so every test
  // here is about it STOPPING. A bug is not a wrong answer — it is turns being
  // paid for until someone notices.
  {
    const { driveGoal } = await import('../src/main/agent/goal/driver.js')
    const { createGoal } = await import('../src/main/agent/goal/state.js')
    const { loadGoal, saveGoal, clearGoal, dropGoalCache } = await import(
      '../src/main/agent/goal/store.js'
    )

    const seed = (sid: string, maxTurns: number) => {
      clearGoal(sid)
      dropGoalCache(sid)
      const r = createGoal(null, { objective: 'do the thing', maxTurns }, new Date(), 'g')
      if (!r.ok) throw new Error(r.error)
      saveGoal(sid, r.goal)
    }

    // Budget: the driver must stop itself with no help from the model.
    {
      const sid = 'goal-budget'
      seed(sid, 3)
      let turns = 0
      await driveGoal(
        async () => {
          turns++
          if (turns > 20) throw new Error('RUNAWAY: the driver did not stop')
        },
        { sessionId: sid, tokensForLastTurn: () => 0, isAborted: () => false },
      )
      // The first turn already happened before driveGoal is called, so a
      // budget of 3 leaves exactly 2 more.
      check('goal: the turn budget stops the driver', turns === 2, `turns=${turns}`)
      check('goal: an exhausted budget BLOCKS, not pauses', loadGoal(sid)?.status === 'blocked')
      check(
        'goal: and says the budget did it',
        loadGoal(sid)?.stopReason === 'turn-budget',
        loadGoal(sid)?.stopReason,
      )
      clearGoal(sid)
    }

    // The model finishing: UpdateGoal clears the record, so the driver returns.
    {
      const sid = 'goal-complete'
      seed(sid, 50)
      let turns = 0
      await driveGoal(
        async () => {
          turns++
          if (turns >= 2) clearGoal(sid) // what UpdateGoal(complete) does
          if (turns > 20) throw new Error('RUNAWAY')
        },
        { sessionId: sid, tokensForLastTurn: () => 0, isAborted: () => false },
      )
      check('goal: a cleared goal ends the driver', turns === 2, `turns=${turns}`)
      check('goal: and nothing is left behind', loadGoal(sid) === null)
    }

    // Abort, already set when the driver is entered: no turn at all.
    {
      const sid = 'goal-abort-before'
      seed(sid, 50)
      let turns = 0
      await driveGoal(
        async () => {
          turns++
        },
        { sessionId: sid, tokensForLastTurn: () => 0, isAborted: () => true },
      )
      check('goal: an already-aborted run takes no turns', turns === 0, `turns=${turns}`)
      check('goal: and pauses rather than blocks', loadGoal(sid)?.status === 'paused')
      clearGoal(sid)
    }

    // Abort raised DURING a turn: that turn finishes (its tools have side
    // effects), and then nothing further starts.
    {
      const sid = 'goal-abort-during'
      seed(sid, 50)
      let turns = 0
      let stopped = false
      await driveGoal(
        async () => {
          turns++
          stopped = true
          if (turns > 20) throw new Error('RUNAWAY')
        },
        { sessionId: sid, tokensForLastTurn: () => 0, isAborted: () => stopped },
      )
      check(
        'goal: aborting mid-turn stops after exactly that turn',
        turns === 1,
        `turns=${turns}`,
      )
      check('goal: interrupted is recorded', loadGoal(sid)?.stopReason === 'interrupted')
      clearGoal(sid)
    }

    // A failing turn must pause, not retry forever.
    {
      const sid = 'goal-error'
      seed(sid, 50)
      let turns = 0
      await driveGoal(
        async () => {
          turns++
          throw new Error('provider exploded')
        },
        { sessionId: sid, tokensForLastTurn: () => 0, isAborted: () => false },
      )
      check('goal: a throwing turn does not retry', turns === 1, `turns=${turns}`)
      check('goal: it pauses (the objective is not at fault)', loadGoal(sid)?.status === 'paused')
      check(
        'goal: and keeps the error',
        loadGoal(sid)?.stopDetail?.includes('exploded') === true,
        loadGoal(sid)?.stopDetail,
      )
      clearGoal(sid)
    }

    // The token budget, independent of turns.
    {
      const sid = 'goal-tokens'
      clearGoal(sid)
      dropGoalCache(sid)
      const r = createGoal(
        null,
        { objective: 'x', maxTurns: 99, maxTokens: 250 },
        new Date(),
        'g',
      )
      if (!r.ok) throw new Error(r.error)
      saveGoal(sid, r.goal)
      let turns = 0
      await driveGoal(
        async () => {
          turns++
          if (turns > 20) throw new Error('RUNAWAY')
        },
        { sessionId: sid, tokensForLastTurn: () => 100, isAborted: () => false },
      )
      check('goal: the token budget also stops it', turns < 20 && turns >= 1, `turns=${turns}`)
      check(
        'goal: blamed on tokens, not turns',
        loadGoal(sid)?.stopReason === 'token-budget',
        loadGoal(sid)?.stopReason,
      )
      clearGoal(sid)
    }

    // A goal found on disk after a restart must never be active: nothing is
    // driving it, and the next message must not silently resume autonomy.
    {
      const sid = 'goal-restart'
      clearGoal(sid)
      dropGoalCache(sid)
      const r = createGoal(null, { objective: 'x' }, new Date(), 'g')
      if (!r.ok) throw new Error(r.error)
      saveGoal(sid, r.goal)
      check('goal: it was active when saved', loadGoal(sid)?.status === 'active')
      dropGoalCache(sid) // simulate a fresh process reading the file
      check(
        'goal: but a restored goal is PAUSED, never active',
        loadGoal(sid)?.status === 'paused',
        loadGoal(sid)?.status,
      )
      clearGoal(sid)
    }
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('SMOKE CRASH:', err)
  process.exit(2)
})

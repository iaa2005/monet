/**
 * The verification loop: what it runs, and above all when it STOPS.
 *
 * Like the goal driver, a bug here is not a wrong answer but a loop that
 * keeps spending money — so the exits get most of the tests: same failure
 * twice, budget, known-red, abort. Detection runs against real temp dirs;
 * the loop runs with injected fakes.
 *
 *   npm run smoke:verify
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectChecks, type VerifyCheck } from '../src/main/verify/detect.js'
import {
  failureSignature,
  fixPrompt,
  runVerifyLoop,
  type KnownRedStore,
} from '../src/main/verify/loop.js'
import type { ChecksVerdict, CheckResult } from '../src/main/verify/run.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Detection ──────────────────────────────────────────────────────────

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-probe-'))
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), body)
  return dir
}

{
  const dir = tempProject({
    'package.json': JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        build: 'vite build',
        dev: 'vite',
      },
    }),
  })
  const checks = detectChecks(dir)
  check(
    'a node project yields its declared checks in order',
    checks.map((c) => c.name).join(',') === 'typecheck,lint,test,build',
    checks.map((c) => c.name),
  )
  check(
    'typecheck and lint are the fast tier, test and build the full one',
    checks.filter((c) => c.tier === 'fast').map((c) => c.name).join(',') ===
      'typecheck,lint' &&
      checks.filter((c) => c.tier === 'full').map((c) => c.name).join(',') ===
        'test,build',
  )
  check(
    'commands default to npm run',
    checks[0]!.command === 'npm run typecheck',
    checks[0]!.command,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = tempProject({
    'package.json': JSON.stringify({
      scripts: {
        test: 'echo "Error: no test specified" && exit 1',
        typecheck: 'tsc --noEmit',
      },
    }),
  })
  const names = detectChecks(dir).map((c) => c.name)
  check(
    "npm init's failing placeholder test is not a check",
    !names.includes('test') && names.includes('typecheck'),
    names,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = tempProject({
    'package.json': JSON.stringify({ scripts: { typecheck: 'tsc' } }),
    'pnpm-lock.yaml': '',
  })
  check(
    'the lockfile picks the package manager',
    detectChecks(dir)[0]!.command === 'pnpm run typecheck',
    detectChecks(dir)[0]!.command,
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = tempProject({
    'package.json': JSON.stringify({
      scripts: { check: 'svelte-check', build: 'vite build' },
    }),
  })
  const checks = detectChecks(dir)
  check(
    'a "check" script becomes the fast gate when there is no typecheck/lint',
    checks[0]!.name === 'check' && checks[0]!.tier === 'fast',
    checks.map((c) => `${c.name}:${c.tier}`),
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = mkdtempSync(join(tmpdir(), 'verify-probe-empty-'))
  check('a folder with no manifests has no checks', detectChecks(dir).length === 0)
  rmSync(dir, { recursive: true, force: true })
}

{
  // The cache must notice a manifest change (the answer follows the file).
  const dir = tempProject({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
  })
  const before = detectChecks(dir).map((c) => c.name)
  // A different mtime AND different content.
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc' } }),
  )
  const after = detectChecks(dir).map((c) => c.name)
  check(
    'the cache follows the manifest',
    before.join(',') === 'lint' && after.join(',') === 'typecheck,lint',
    { before, after },
  )
  rmSync(dir, { recursive: true, force: true })
}

// ─── Signatures and the fix prompt ──────────────────────────────────────

check(
  'a signature ignores whitespace shuffling',
  failureSignature('typecheck', 'error  TS2345\n  at foo.ts') ===
    failureSignature('typecheck', 'error TS2345 at foo.ts'),
)
check(
  'but not a different error',
  failureSignature('typecheck', 'error TS2345') !==
    failureSignature('typecheck', 'error TS9999'),
)
check(
  'or a different check',
  failureSignature('typecheck', 'boom') !== failureSignature('lint', 'boom'),
)

{
  const failing: CheckResult = {
    check: {
      name: 'typecheck',
      command: 'npm run typecheck',
      tier: 'fast',
      timeoutMs: 120_000,
    },
    ok: false,
    output: "error TS2345: Argument of type 'string'",
    exitCode: 2,
    timedOut: false,
    aborted: false,
  }
  const prompt = fixPrompt(failing)
  check(
    'the fix prompt carries the command and the output',
    prompt.includes('npm run typecheck') && prompt.includes('TS2345'),
  )
  check(
    'and offers the pre-existing way out',
    prompt.includes('pre-existing'),
  )
}

// ─── The loop's exits ───────────────────────────────────────────────────

const FAST: VerifyCheck = {
  name: 'typecheck',
  command: 'npm run typecheck',
  tier: 'fast',
  timeoutMs: 120_000,
}

function failureOf(output: string): ChecksVerdict {
  return {
    failure: {
      check: FAST,
      ok: false,
      output,
      exitCode: 1,
      timedOut: false,
      aborted: false,
    },
    ran: 1,
    aborted: false,
  }
}
const GREEN: ChecksVerdict = { failure: null, ran: 1, aborted: false }

interface Run {
  turns: string[]
  events: string[]
  red: { added: string[]; cleared: number; preloaded: string[] }
}

async function drive(
  script: (attempt: number) => ChecksVerdict,
  opts: {
    maxAttempts?: number
    preloadRed?: string[]
    detectNone?: boolean
    abortedFrom?: number
  } = {},
): Promise<Run & { status: string; attempts: number }> {
  const run: Run = {
    turns: [],
    events: [],
    red: { added: [], cleared: 0, preloaded: opts.preloadRed ?? [] },
  }
  const knownRed: KnownRedStore = {
    has: (sig) => run.red.preloaded.includes(sig),
    add: (sig) => void run.red.added.push(sig),
    clear: () => void run.red.cleared++,
  }
  let checksRan = 0
  const outcome = await runVerifyLoop({
    cwd: 'C:/fake',
    runTurn: async (prompt) => void run.turns.push(prompt),
    isAborted: () =>
      opts.abortedFrom !== undefined && checksRan >= opts.abortedFrom,
    emit: (e) => {
      const ev = e as { type: string; phase?: string }
      if (ev.type === 'verify') run.events.push(ev.phase!)
    },
    maxAttempts: opts.maxAttempts,
    knownRed,
    detect: () => (opts.detectNone ? [] : [FAST]),
    execute: async () => script(checksRan++),
  })
  return { ...run, status: outcome.status, attempts: outcome.attempts }
}

{
  const r = await drive(() => GREEN, { detectNone: true })
  check('no checks → skipped, silently', r.status === 'skipped' && r.events.length === 0)
}

{
  const r = await drive(() => GREEN)
  check(
    'green on the first pass → clean, no fix turns',
    r.status === 'clean' && r.turns.length === 0,
    r,
  )
  check(
    'and the strip heard checking → clean',
    r.events.join(',') === 'checking,clean',
    r.events,
  )
  check('a green run clears known-red', r.red.cleared === 1)
}

{
  const r = await drive((n) => (n === 0 ? failureOf('error TS1') : GREEN))
  check(
    'one failure, one fix turn, then green → fixed',
    r.status === 'fixed' && r.turns.length === 1 && r.attempts === 1,
    r,
  )
  check(
    'the fix turn got the failure to read',
    r.turns[0]!.includes('error TS1'),
  )
  check(
    'events tell the story: checking, fixing, checking, fixed',
    r.events.join(',') === 'checking,fixing,checking,fixed',
    r.events,
  )
}

{
  const r = await drive(() => failureOf('error TS1'))
  check(
    'the same failure twice ends the loop after ONE fix turn',
    r.status === 'gave-up' && r.turns.length === 1,
    r,
  )
  check(
    'and the failure is remembered as known-red',
    r.red.added.length === 1 &&
      r.red.added[0] === failureSignature('typecheck', 'error TS1'),
    r.red.added,
  )
}

{
  const r = await drive((n) => failureOf(`error TS${n}`), { maxAttempts: 2 })
  check(
    'a failure that keeps CHANGING runs out of budget instead',
    r.status === 'gave-up' && r.turns.length === 2 && r.attempts === 2,
    r,
  )
  check(
    'progress is not remembered as known-red',
    r.red.added.length === 0,
    r.red.added,
  )
}

{
  const sig = failureSignature('typecheck', 'error TS1')
  const r = await drive(() => failureOf('error TS1'), { preloadRed: [sig] })
  check(
    "a known pre-existing failure costs no fix turn",
    r.status === 'known-red' && r.turns.length === 0,
    r,
  )
  check(
    'and the strip says so',
    r.events.includes('known-red'),
    r.events,
  )
}

{
  const r = await drive(() => failureOf('error TS1'), { abortedFrom: 0 })
  check(
    'stop pressed before the first check → aborted, nothing run',
    r.status === 'aborted' && r.turns.length === 0,
    r,
  )
}

{
  const r = await drive(
    () => ({ failure: null, ran: 0, aborted: true }),
  )
  check(
    'a check killed by stop is not a verdict',
    r.status === 'aborted' && r.turns.length === 0,
    r,
  )
}

console.log(
  failures === 0 ? '\nALL VERIFY CHECKS PASSED' : `\n${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

/**
 * The completion judge: what rejects, what accepts, and above all what FAILS
 * OPEN. The judge sits between every goal and its end — a judge that could
 * block on its own infrastructure, or reject forever, would be a worse bug
 * than the over-eager completions it exists to catch.
 *
 *   npm run smoke:judge
 */

import {
  judgeCompletion,
  MAX_JUDGE_REJECTIONS,
  type JudgeVerdict,
} from '../src/main/agent/goal/judge.js'
import {
  createGoal,
  recordJudgeRejection,
  type Goal,
} from '../src/main/agent/goal/state.js'
import type { VerifyCheck } from '../src/main/verify/detect.js'
import type { ChecksVerdict } from '../src/main/verify/run.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const NOW = new Date('2026-08-02T12:00:00Z')
function goalOf(): Goal {
  const r = createGoal(
    null,
    { objective: 'make the tests pass', completionCriterion: 'npm test is green' },
    NOW,
    'g1',
  )
  if (!r.ok) throw new Error(r.error)
  return r.goal
}

const TYPECHECK: VerifyCheck = {
  name: 'typecheck',
  command: 'npm run typecheck',
  tier: 'fast',
  timeoutMs: 120_000,
}
const TEST: VerifyCheck = {
  name: 'test',
  command: 'npm test',
  tier: 'full',
  timeoutMs: 420_000,
}

const GREEN: ChecksVerdict = { failure: null, ran: 2, aborted: false }
const RED_TEST: ChecksVerdict = {
  failure: {
    check: TEST,
    ok: false,
    output: '3 tests failed: auth.spec.ts',
    exitCode: 1,
    timedOut: false,
    aborted: false,
  },
  ran: 2,
  aborted: false,
}

interface Trace {
  llmCalls: number
  lastUser?: string
}

async function judge(opts: {
  checks?: ChecksVerdict
  llm?: string | Error
  cwd?: string
  diff?: string | null
  claimed?: string
}): Promise<JudgeVerdict & { trace: Trace }> {
  const trace: Trace = { llmCalls: 0 }
  const verdict = await judgeCompletion({
    goal: goalOf(),
    claimedSummary: opts.claimed ?? 'Done: fixed the flaky mock, npm test green.',
    cwd: opts.cwd,
    diff: opts.diff ?? null,
    detect: () => [TYPECHECK, TEST],
    execute: async () => opts.checks ?? GREEN,
    complete: async (_system, user) => {
      trace.llmCalls++
      trace.lastUser = user
      if (opts.llm instanceof Error) throw opts.llm
      return opts.llm ?? '{"verdict":"accept","reason":"looks done"}'
    },
  })
  return { ...verdict, trace }
}

// ─── Layer 1: the checks decide without a model ─────────────────────────

{
  const r = await judge({ cwd: 'C:/w', checks: RED_TEST })
  check(
    'a red check rejects the completion with no model call',
    r.verdict === 'reject' && r.trace.llmCalls === 0,
    r,
  )
  check(
    'and the rejection names the check and quotes it',
    r.verdict === 'reject' && r.reason.includes('test') && r.reason.includes('auth.spec.ts'),
    r,
  )
}

{
  const r = await judge({ cwd: 'C:/w', checks: GREEN, llm: '{"verdict":"accept"}' })
  check(
    'green checks hand the decision to the fresh context',
    r.verdict === 'accept' && r.trace.llmCalls === 1,
    r,
  )
  check(
    'which reads the objective, the claim and the checks',
    !!r.trace.lastUser &&
      r.trace.lastUser.includes('make the tests pass') &&
      r.trace.lastUser.includes('flaky mock') &&
      r.trace.lastUser.includes('2 project check(s) pass'),
  )
}

{
  const r = await judge({ cwd: 'C:/w', diff: 'diff --git a/x.ts b/x.ts\n+fixed' })
  check(
    'the diff rides along as evidence',
    !!r.trace.lastUser && r.trace.lastUser.includes('+fixed'),
  )
}

{
  const r = await judge({}) // no cwd — a Home goal
  check(
    'a Home goal skips the checks but still gets judged',
    r.trace.llmCalls === 1 &&
      !!r.trace.lastUser &&
      r.trace.lastUser.includes('No project checks'),
    r.trace,
  )
}

// ─── Layer 2: the fresh context's word ──────────────────────────────────

{
  const r = await judge({
    cwd: 'C:/w',
    llm: '{"verdict":"reject","reason":"the criterion names npm test green but no test run appears in the claim or diff"}',
  })
  check(
    'the judge can send a completion back, with a concrete reason',
    r.verdict === 'reject' && r.reason.includes('npm test'),
    r,
  )
}

{
  const r = await judge({
    cwd: 'C:/w',
    llm: '```json\n{"verdict":"reject","reason":"nothing changed"}\n```',
  })
  check(
    'a fenced reply still parses',
    r.verdict === 'reject' && r.reason === 'nothing changed',
    r,
  )
}

// ─── Failing open ───────────────────────────────────────────────────────

{
  const r = await judge({ cwd: 'C:/w', llm: new Error('provider down') })
  check(
    'a dead judge accepts — the claim stands',
    r.verdict === 'accept',
    r,
  )
}

{
  const r = await judge({ cwd: 'C:/w', llm: 'I think this looks mostly fine?' })
  check(
    'prose instead of JSON is the judge\'s failure, not the worker\'s',
    r.verdict === 'accept',
    r,
  )
}

{
  const r = await judge({
    cwd: 'C:/w',
    llm: '{"verdict":"reject"}', // reject with no reason is not a verdict
  })
  check(
    'a reject without a reason does not count',
    r.verdict === 'accept',
    r,
  )
}

// ─── The cap ────────────────────────────────────────────────────────────

{
  let g = goalOf()
  check('a fresh goal has no rejections', (g.judgeRejections ?? 0) === 0)
  g = recordJudgeRejection(g, NOW)
  g = recordJudgeRejection(g, NOW)
  check('rejections count up', g.judgeRejections === 2)
  check(
    'and the cap is what the tool consults',
    (g.judgeRejections ?? 0) >= MAX_JUDGE_REJECTIONS,
    { rejections: g.judgeRejections, cap: MAX_JUDGE_REJECTIONS },
  )
  check(
    'rejection does not touch the turn budget',
    g.stats.turns === 0 && g.status === 'active',
  )
}

console.log(failures === 0 ? '\nALL JUDGE CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

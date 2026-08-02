/**
 * Run notes: the store's caps, the workspace key, and both history blocks —
 * what a goal reminder and a routine prompt actually carry forward. Runs
 * under the electron stub with the data dir in a temp folder.
 *
 *   npm run smoke:runnotes
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'run-notes-probe-'))
setDataDir(tempData)

const {
  addGoalRunNote,
  goalHistoryBlock,
  goalRunNotes,
  routineHistoryBlock,
  workspaceKey,
} = await import('../src/main/agent/run-notes.js')
const { activeGoalReminder } = await import('../src/main/agent/goal/inject.js')
const { createGoal } = await import('../src/main/agent/goal/state.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const WS = 'D:/Projects/claude-code/desktop'

// ─── The key ────────────────────────────────────────────────────────────

check(
  'one folder, one key, however the path is spelled',
  workspaceKey('D:\\Projects\\X\\') === workspaceKey('d:/projects/x'),
)

// ─── The store ──────────────────────────────────────────────────────────

const note = (i: number, outcome: 'complete' | 'blocked' = 'complete') => ({
  at: `2026-08-0${(i % 9) + 1}T10:00:00.000Z`,
  outcome,
  ...(outcome === 'blocked' ? { reason: 'turn-budget' } : {}),
  objective: `objective ${i}`,
  note: `note ${i}`,
  turns: i,
})

addGoalRunNote(WS, note(1))
addGoalRunNote(WS.replace(/\//g, '\\').toUpperCase(), note(2))
check(
  'notes filed under spelling variants land in one scope',
  goalRunNotes(WS).length === 2,
  goalRunNotes(WS),
)
check('another workspace has none', goalRunNotes('D:/elsewhere').length === 0)

for (let i = 3; i <= 9; i++) addGoalRunNote(WS, note(i))
{
  const notes = goalRunNotes(WS)
  check('the store keeps only the last five', notes.length === 5, notes.length)
  check(
    'and the five NEWEST',
    notes[0]!.objective === 'objective 5' && notes[4]!.objective === 'objective 9',
    notes.map((n) => n.objective),
  )
}

// ─── The goal history block ─────────────────────────────────────────────

check('no notes, no block', goalHistoryBlock([]) === null)
{
  const block = goalHistoryBlock(goalRunNotes(WS))!
  check(
    'the block shows three at most, newest first',
    (block.match(/^- \[/gm) ?? []).length === 3 &&
      block.indexOf('objective 9') < block.indexOf('objective 8'),
    block,
  )
  check(
    'and tells the next goal what history is FOR',
    block.includes('continuity') && block.includes('already done'),
  )
}
{
  addGoalRunNote('D:/blocked-ws', note(1, 'blocked'))
  const block = goalHistoryBlock(goalRunNotes('D:/blocked-ws'))!
  check(
    'a blocked goal names its wall',
    block.includes('blocked (turn-budget)') && block.includes('note 1'),
    block,
  )
}
{
  const long = {
    at: '2026-08-02T10:00:00.000Z',
    outcome: 'complete' as const,
    objective: 'x'.repeat(500),
    note: 'y'.repeat(2_000),
    turns: 3,
  }
  const block = goalHistoryBlock([long])!
  check('one runaway note cannot flood the reminder', block.length < 600, block.length)
}

// ─── Into the reminder itself ───────────────────────────────────────────

{
  const r = createGoal(null, { objective: 'ship it' }, new Date(), 'g1')
  if (!r.ok) throw new Error(r.error)
  const history = goalHistoryBlock(goalRunNotes(WS))!
  const withH = activeGoalReminder(r.goal, history)
  const without = activeGoalReminder(r.goal)
  check(
    'the reminder carries the history when given one',
    withH.includes('Earlier goals in this workspace') &&
      !without.includes('Earlier goals'),
  )
  check(
    'history sits outside the untrusted envelope',
    withH.indexOf('Earlier goals') > withH.indexOf('</untrusted_objective>'),
  )
}

// ─── The routine block ──────────────────────────────────────────────────

{
  const runs = [
    { at: '2026-08-02T09:00:00.000Z', status: 'ok', summary: 'sent the digest' },
    { at: '2026-08-01T09:00:00.000Z', status: 'skipped' },
    { at: '2026-07-31T09:00:00.000Z', status: 'error', error: 'IMAP timeout' },
    { at: '2026-07-30T09:00:00.000Z', status: 'running' },
    { at: '2026-07-29T09:00:00.000Z', status: 'ok', summary: 'first run' },
  ]
  const block = routineHistoryBlock(runs)!
  check(
    'a routine carries ok and error runs, not skips or ghosts',
    block.includes('sent the digest') &&
      block.includes('FAILED: IMAP timeout') &&
      !block.includes('skipped') &&
      (block.match(/^- \[/gm) ?? []).length === 3,
    block,
  )
  check(
    'and the failure is an instruction, not trivia',
    block.includes('address the cause'),
  )
  check(
    'nothing but skips → no block at all',
    routineHistoryBlock([{ at: '2026-08-02T09:00:00.000Z', status: 'skipped' }]) === null,
  )
}

rmSync(tempData, { recursive: true, force: true })
rmSync(join(process.cwd(), 'monet-bootstrap.json'), { force: true })

console.log(failures === 0 ? '\nALL RUN-NOTES CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

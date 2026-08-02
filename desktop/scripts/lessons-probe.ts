/**
 * Project lessons: the store (write, history, rollback), the scoped
 * injection, and the dream's gates. Runs under the electron stub
 * (smoke-agent.mjs) with the data dir pointed at a temp folder, so nothing
 * touches the real memory.
 *
 *   npm run smoke:lessons
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

// FIRST, before anything resolves getDataDir(): everything this probe writes
// goes to a temp dir, not the developer's own .monet.
const tempData = mkdtempSync(join(tmpdir(), 'lessons-probe-'))
setDataDir(tempData)

const {
  buildLessonsPrompt,
  deleteLessons,
  getLessonsState,
  lessonsSlug,
  listLessons,
  readLessons,
  rollbackLessons,
  runLessonsDream,
  shouldDreamLessonsNow,
  writeLessons,
} = await import('../src/main/memory/lessons.js')

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
const OTHER = 'D:/Other/desktop' // same basename, different folder

// ─── Slugs ──────────────────────────────────────────────────────────────

check(
  'a slug is stable',
  lessonsSlug(WS) === lessonsSlug(WS) && lessonsSlug(WS) === lessonsSlug(WS + '/'),
)
check(
  'two folders named alike do not share a memory',
  lessonsSlug(WS) !== lessonsSlug(OTHER),
  { a: lessonsSlug(WS), b: lessonsSlug(OTHER) },
)
check(
  'and the slug still says which project it is',
  lessonsSlug(WS).startsWith('desktop-'),
  lessonsSlug(WS),
)

// ─── The store ──────────────────────────────────────────────────────────

writeLessons(WS, { summary: 'first pass', body: '- npm test needs the dev server down' })
{
  const l = readLessons(WS)
  check(
    'a write reads back, workspace and all',
    !!l && l.workspace === WS && l.body.includes('dev server') && l.summary === 'first pass',
    l,
  )
  check('one version deep there is nothing to roll back to', l?.canRollback === false)
}

writeLessons(WS, { summary: 'second pass', body: '- use bun, not npm' })
{
  const l = readLessons(WS)
  check('a second write replaces the body', !!l && l.body.includes('bun'), l?.body)
  check('and keeps the old one to roll back to', l?.canRollback === true)
}

{
  const r = rollbackLessons(WS)
  const l = readLessons(WS)
  check(
    'rollback restores the previous version',
    r.ok && !!l && l.body.includes('dev server') && l.summary === 'first pass',
    { r, body: l?.body },
  )
}

{
  // History is capped: eight writes keep at most five versions behind HEAD.
  for (let i = 0; i < 8; i++)
    writeLessons(WS, { summary: `pass ${i}`, body: `- lesson ${i}` })
  let undone = 0
  while (rollbackLessons(WS).ok) undone++
  check('history keeps at most five versions', undone === 5, { undone })
}

// ─── Scoped injection ───────────────────────────────────────────────────

writeLessons(WS, { summary: 's', body: '- the build is flaky on Tuesdays' })
{
  const prompt = buildLessonsPrompt(WS)
  check(
    'the prompt carries the preamble and the lessons',
    !!prompt && prompt.includes('# Project lessons') && prompt.includes('Tuesdays'),
  )
  check('another workspace gets nothing', buildLessonsPrompt(OTHER) === null)
  check('no workspace, no prompt', buildLessonsPrompt(undefined) === null)
}

{
  writeLessons(OTHER, { summary: 'long', body: 'x'.repeat(10_000) })
  const prompt = buildLessonsPrompt(OTHER)
  check(
    'an oversized lessons file is capped, not injected whole',
    !!prompt && prompt.length < 3_000,
    prompt?.length,
  )
  deleteLessons(OTHER)
}

{
  const before = listLessons().length
  deleteLessons(WS)
  check(
    'delete forgets the workspace, history included',
    listLessons().length === before - 1 &&
      readLessons(WS) === null &&
      !rollbackLessons(WS).ok,
  )
}

// ─── The dream and its gates ────────────────────────────────────────────

const SIGNALS = new Map([
  [
    WS,
    [
      { kind: 'tool-error' as const, text: 'Bash failed — npm test: port 5173 in use' },
      { kind: 'tool-error' as const, text: 'Bash failed — npm test: port 5173 in use' },
      { kind: 'chat-error' as const, text: 'Chat "fix build" stopped on: provider timeout' },
    ],
  ],
  [OTHER, [{ kind: 'tool-error' as const, text: 'one lonely failure' }]],
])

check(
  'a fresh install is overdue for its first dream',
  shouldDreamLessonsNow(new Date('2026-08-02T12:00:00')),
)

{
  const r = await runLessonsDream({ gather: async () => new Map() })
  check(
    'a quiet week is a no-op that still advances the clock',
    r.ok && !r.ran && r.reason === 'not enough signal' && getLessonsState().lastRunAt > 0,
    r,
  )
}

{
  const r = await runLessonsDream({ gather: async () => SIGNALS })
  check(
    'and the clock now gates the next pass',
    r.ok && !r.ran && (r.reason ?? '').includes('since last run'),
    r,
  )
}

{
  let sawSignals = false
  const r = await runLessonsDream({
    force: true,
    gather: async () => SIGNALS,
    complete: async (_system, user) => {
      if (user.includes('port 5173')) sawSignals = true
      return '{"lessons": "- kill the dev server before npm test", "summary": "learned about port 5173"}'
    },
  })
  check(
    'signals become lessons for the workspace that earned them',
    r.ok && r.ran && r.touched?.length === 2, // force lowers the bar to 1 signal
    r,
  )
  check('the model read the actual signals', sawSignals)
  check(
    'and the next session in that folder will start with them',
    (buildLessonsPrompt(WS) ?? '').includes('kill the dev server'),
  )
}

{
  const r = await runLessonsDream({
    force: true,
    gather: async () => SIGNALS,
    complete: async () => '{"lessons": null, "summary": "nothing new"}',
  })
  check(
    'a "nothing new" verdict writes nothing',
    r.ok && r.ran && r.touched?.length === 0,
    r,
  )
}

{
  const before = getLessonsState().lastRunAt
  const r = await runLessonsDream({
    force: true,
    gather: async () => SIGNALS,
    complete: async () => {
      throw new Error('provider down')
    },
  })
  check(
    'a dead model fails the run and keeps the signals eligible',
    !r.ok && !!r.error && getLessonsState().lastRunAt === before,
    { r, before, after: getLessonsState().lastRunAt },
  )
  check('and the failure is on record', getLessonsState().lastError === 'provider down')
}

{
  // MIN_SIGNALS without force: only the workspace with three signals learns.
  // Age the clock by hand (the state file is ours in this temp data dir).
  writeFileSync(
    join(tempData, 'lessons-state.json'),
    JSON.stringify({ lastRunAt: Date.now() - 25 * 3_600_000 }),
  )
  deleteLessons(WS)
  deleteLessons(OTHER) // the force pass above taught it too — clean slate
  const r = await runLessonsDream({
    gather: async () => SIGNALS,
    complete: async () => '{"lessons": "- a lesson", "summary": "s"}',
  })
  check(
    'without force, one lonely failure does not earn a lessons file',
    r.ok && r.ran && r.touched?.length === 1 && r.touched[0] === WS,
    r,
  )
  check(
    'so the noisy workspace learned and the quiet one did not',
    readLessons(WS) !== null && readLessons(OTHER) === null,
  )
}

rmSync(tempData, { recursive: true, force: true })
rmSync(join(process.cwd(), 'monet-bootstrap.json'), { force: true })

console.log(failures === 0 ? '\nALL LESSONS CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

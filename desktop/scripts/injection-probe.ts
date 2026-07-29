/**
 * Checks mid-turn injection: who may inject, when it is delivered, and — the
 * part that matters — that nothing leaks between runs.
 *
 * The lifecycle is the risk here. Text handed to a run that then aborts must
 * not surface in the NEXT turn as a correction against work that has already
 * changed, and a session that is idle must refuse the injection so the caller
 * can fall back to an ordinary send instead of swallowing what someone typed.
 */

import {
  drainInjections,
  formatInjection,
  hasInjections,
  injectMessage,
  isRunning,
  markRunning,
  markStopped,
} from '../src/main/agent/injection.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Only a running session accepts text ────────────────────────────────

check('an idle session refuses', !injectMessage('s1', 'hello'))
check('and stores nothing', !hasInjections('s1'))
check('isRunning agrees', !isRunning('s1'))

markRunning('s1')
check('a running session accepts', injectMessage('s1', 'use the other API'))
check('and holds it', hasInjections('s1'))

check('blank text is refused', !injectMessage('s1', '   '))

// ─── Delivery ───────────────────────────────────────────────────────────

injectMessage('s1', 'and add a test')
const drained = drainInjections('s1')
check('both notes come back in order', drained.length === 2, drained)
check('the first is the first typed', drained[0] === 'use the other API', drained[0])
check('text is trimmed', drained[1] === 'and add a test', drained[1])
check('draining empties the queue', !hasInjections('s1'))
check('draining twice is safe', drainInjections('s1').length === 0)

// ─── Sessions do not bleed into each other ──────────────────────────────

markRunning('s2')
injectMessage('s1', 'for one')
injectMessage('s2', 'for two')
check('s1 gets only its own', drainInjections('s1').join() === 'for one')
check('s2 gets only its own', drainInjections('s2').join() === 'for two')

// ─── The lifecycle guard ────────────────────────────────────────────────

injectMessage('s1', 'never delivered')
check('undelivered text exists while running', hasInjections('s1'))
markStopped('s1')
check(
  'a stopped run drops undelivered text',
  !hasInjections('s1'),
  drainInjections('s1'),
)
check('a stopped session refuses new text', !injectMessage('s1', 'too late'))

// A fresh run must start clean, not inherit the last one's leftovers.
markRunning('s1')
check('the next run starts with nothing pending', !hasInjections('s1'))
markStopped('s1')
markStopped('s2')

// ─── Framing ────────────────────────────────────────────────────────────

const framed = formatInjection(['stop using regex here'])
check('the note carries the user text', framed.includes('stop using regex here'))
check(
  'and says it came from the user mid-turn',
  /user sent this WHILE you were working/i.test(framed),
  framed.slice(0, 80),
)
check(
  'and warns it is not tool output',
  /not tool output/i.test(framed),
)
check(
  'several notes are joined, not lost',
  ((): boolean => {
    const f = formatInjection(['first', 'second'])
    return f.includes('first') && f.includes('second')
  })(),
)

console.log(failures === 0 ? '\nALL INJECTION CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

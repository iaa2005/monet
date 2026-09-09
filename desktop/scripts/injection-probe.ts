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
  cancelInjection,
  drainInjections,
  formatInjection,
  hasInjections,
  injectMessage,
  injectionBlocks,
  isRunning,
  markRunning,
  markStopped,
} from '../src/main/agent/injection.js'
import type { LLMContentBlock } from '../src/main/llm/adapter.js'

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
check('the first is the first typed', drained[0]?.text === 'use the other API', drained[0])
check('text is trimmed', drained[1]?.text === 'and add a test', drained[1])
check('draining empties the queue', !hasInjections('s1'))
check('draining twice is safe', drainInjections('s1').length === 0)

// ─── Taking a note back ─────────────────────────────────────────────────

// The window between saying something and the run reading it is a whole
// tool call — minutes, on a slow one. Withdrawing has to be decided by the
// side that owns the list, because only it knows whether the step boundary
// has already passed; the chat asks and believes the answer.

markRunning('s9')
{
  const first = injectMessage('s9', 'the first thing')!
  const second = injectMessage('s9', 'the second thing')!
  check('two notes, two different ids', !!first && !!second && first !== second, {
    first,
    second,
  })
  check('cancelling gives the words back', cancelInjection('s9', first) === 'the first thing')
  check('cancelling the same note twice says no', cancelInjection('s9', first) === null)
  check('the other note is untouched', hasInjections('s9'))
  const left = drainInjections('s9')
  check('and it is the one NOT cancelled', left.map((n) => n.text).join() === 'the second thing', left)
  check('a cancel after delivery says no', cancelInjection('s9', second) === null)
}
// Saying the same thing twice is exactly where matching by text picks the
// wrong note — which is why notes carry an id at all.
{
  const a = injectMessage('s9', 'same words')!
  const b = injectMessage('s9', 'same words')!
  check('identical text still gets distinct ids', a !== b)
  cancelInjection('s9', a)
  const left = drainInjections('s9')
  check('cancelling one of a pair leaves exactly one', left.length === 1, left)
}
check('an unknown id on an unknown session says no', cancelInjection('nope', 'nope') === null)
markStopped('s9')

// ─── Sessions do not bleed into each other ──────────────────────────────

markRunning('s2')
injectMessage('s1', 'for one')
injectMessage('s2', 'for two')
check('s1 gets only its own', drainInjections('s1').map((n) => n.text).join() === 'for one')
check('s2 gets only its own', drainInjections('s2').map((n) => n.text).join() === 'for two')

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

const framed = formatInjection([{ id: 'n1', text: 'stop using regex here' }])
check('the note carries the user text', framed.includes('stop using regex here'))
check(
  'and says it came from the user mid-turn',
  /user said this WHILE you were working/i.test(framed),
  framed.slice(0, 80),
)
check(
  'and warns it is not tool output',
  /not tool output/i.test(framed),
)
check(
  'several notes are joined, not lost',
  ((): boolean => {
    const f = formatInjection([{ id: 'n1', text: 'first' }, { id: 'n2', text: 'second' }])
    return f.includes('first') && f.includes('second')
  })(),
)

// ─── Files ride along ───────────────────────────────────────────────────

const img: LLMContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
}
markRunning('s3')
check('a note with files but no words is accepted', injectMessage('s3', '', [img]))
injectMessage('s3', 'look at this', [img])
check('a note with neither is not', !injectMessage('s3', '  '))
{
  const notes = drainInjections('s3')
  check('blocks survive the drain', notes.length === 2 && notes[1]?.blocks?.length === 1, notes)
  check('injectionBlocks flattens in order', injectionBlocks(notes).length === 2)
  const f = formatInjection(notes)
  check('the framing mentions the attached files', /attached file/i.test(f), f.slice(-80))
}
markStopped('s3')

console.log(failures === 0 ? '\nALL INJECTION CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

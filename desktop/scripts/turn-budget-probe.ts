/**
 * The step budget: when the heads-up fires, and what the wrap-up asks for.
 *
 * The warning has to fire exactly ONCE per run — a note repeated every turn
 * would be noise the model learns to skip, and one that never fires leaves
 * the cap as invisible as it was. The wrap-up prompt is checked for the two
 * things it must say, because a wrap-up that lets the model believe it can
 * still act just spends the last turn on a tool call nobody answers.
 *
 *   npm run smoke:turnbudget
 */

import {
  budgetWarning,
  callSignature,
  dominantRepeat,
  EXTENSION_TURNS,
  extensionFor,
  extensionNote,
  isProductive,
  loopNote,
  MAX_EXTENSIONS,
  MAX_LOOP_STEERS,
  shouldSteerLoop,
  shouldWarnBudget,
  STEER_SPACING,
  stepsLeft,
  WARN_AT_FRACTION,
  WRAP_UP_PROMPT,
} from '../src/main/agent/turn-budget.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── When the heads-up fires ────────────────────────────────────────────

{
  const fired = [...Array(40).keys()].filter((t) => shouldWarnBudget(t, 40))
  check('exactly one warning in a 40-step run', fired.length === 1, fired)
  check('at three quarters spent', fired[0] === 29, fired)
  check(
    'and it says how many are left',
    stepsLeft(fired[0]!, 40) === 10,
    stepsLeft(fired[0]!, 40),
  )
}

{
  const fired = [...Array(30).keys()].filter((t) => shouldWarnBudget(t, 30))
  check('one warning in a routine run too', fired.length === 1, fired)
  check('scaled to its own budget', stepsLeft(fired[0]!, 30) === 8, fired)
}

check('the fraction is late, not early', WARN_AT_FRACTION >= 0.7)
check(
  'a budget too small to warn about does not warn',
  [...Array(3).keys()].every((t) => !shouldWarnBudget(t, 3)),
)
check('steps left never goes negative', stepsLeft(50, 40) === 0)

// ─── What the notes say ─────────────────────────────────────────────────

{
  const w = budgetWarning(10)
  check('the warning states the number', w.includes('10 step(s) left'), w)
  check(
    'and tells it to converge rather than explore',
    /converg/i.test(w) && /not open a new/i.test(w),
    w,
  )
  check('it is one short line, not a lecture', w.length < 320, w.length)
}

check(
  'the wrap-up forbids tool calls outright',
  /do not try to call one/i.test(WRAP_UP_PROMPT),
  WRAP_UP_PROMPT,
)
check(
  'and asks for done / broken / next',
  /accomplished/i.test(WRAP_UP_PROMPT) &&
    /still broken|unfinished/i.test(WRAP_UP_PROMPT) &&
    /next step/i.test(WRAP_UP_PROMPT),
)
check(
  'it does not ask for a plan document',
  /no .*plan document/i.test(WRAP_UP_PROMPT),
)

// ─── Earning more steps ─────────────────────────────────────────────────

const sig = (n: number) => callSignature('Edit', { file_path: `f${n}.ts` })
const varied = (n: number) => [...Array(n).keys()].map(sig)
const stuck = (n: number) => [...Array(n).keys()].map(() => callSignature('BrowserReadPage', {}))

check(
  'the same call with the same input is one signature',
  callSignature('BrowserReadPage', {}) === callSignature('BrowserReadPage', {}),
)
check(
  'the same tool on a different target is not',
  callSignature('BrowserClick', { ref: 'a' }) !==
    callSignature('BrowserClick', { ref: 'b' }),
)

check('a run doing new things is productive', isProductive(varied(20)))
check('a run repeating one call is not', !isProductive(stuck(20)))
check(
  'the judgement is on the RECENT window, not the whole run',
  !isProductive([...varied(30), ...stuck(12)]),
)
check(
  'and a good tail rescues a bad history',
  isProductive([...stuck(30), ...varied(12)]),
)
check('too few calls to judge is not held against it', isProductive(varied(2)))

{
  const at = (o: Partial<Parameters<typeof extensionFor>[0]> = {}) =>
    extensionFor({
      turnsDone: 40,
      budget: 40,
      extensionsUsed: 0,
      signatures: varied(20),
      ...o,
    })
  check('at the wall and still working → more steps', at() === EXTENSION_TURNS)
  check('at the wall and repeating → none', at({ signatures: stuck(20) }) === 0)
  check('not at the wall → nothing to decide', at({ turnsDone: 39 }) === 0)
  check(
    'the extensions themselves run out',
    at({ extensionsUsed: MAX_EXTENSIONS }) === 0,
  )
  check(
    'so the ceiling is bounded, not open-ended',
    40 + MAX_EXTENSIONS * EXTENSION_TURNS <= 100,
    40 + MAX_EXTENSIONS * EXTENSION_TURNS,
  )
}

{
  const n = extensionNote(20, 60)
  check('the note says how much and how far', n.includes('20') && n.includes('60'), n)
  check('and that it is not free', /not be extended indefinitely/i.test(n))
}

// ─── Loop steering ──────────────────────────────────────────────────────
//
// The same repetition evidence, but SPOKEN — capped and spaced so the
// correction cannot become its own loop.

{
  const rep = dominantRepeat(stuck(12))
  check(
    'the dominant repeat names the tool and the count',
    rep?.toolName === 'BrowserReadPage' && rep.count === 12,
    rep,
  )
  check('varied work has no dominant repeat', dominantRepeat(varied(12)) === null)
  check(
    'two repeats is variance, not a loop',
    dominantRepeat([...varied(9), ...stuck(2)]) === null,
    dominantRepeat([...varied(9), ...stuck(2)]),
  )
}

{
  const steer = (o: Partial<Parameters<typeof shouldSteerLoop>[0]> = {}) =>
    shouldSteerLoop({
      signatures: stuck(12),
      steersUsed: 0,
      sinceLastSteer: 99,
      ...o,
    })
  check('a stuck run gets a steer', steer())
  check('a productive run does not', !steer({ signatures: varied(12) }))
  check(
    'the steers themselves run out',
    !steer({ steersUsed: MAX_LOOP_STEERS }),
  )
  check(
    'a fresh correction gets room to work before the next',
    !steer({ sinceLastSteer: STEER_SPACING - 1 }) &&
      steer({ sinceLastSteer: STEER_SPACING }),
  )
  check(
    'too few calls to judge is never steered',
    !steer({ signatures: stuck(3) }),
  )
}

{
  const n = loopNote('BrowserReadPage', 9)
  check(
    'the note names the call and the count',
    n.includes('BrowserReadPage') && n.includes('9'),
    n,
  )
  check('and demands a change, not an apology', /change/i.test(n), n)
  check('it is short', n.length < 340, n.length)
}

console.log(
  failures === 0 ? '\nALL TURN-BUDGET CHECKS PASSED' : `\n${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

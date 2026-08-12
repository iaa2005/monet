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
  GIVE_UP_AFTER,
  isStuck,
  MAX_LOOP_STEERS,
  stuckWrapUp,
  extensionNote,
  isProductive,
  loopNote,
  MAX_EXTENSIONS,
  MAX_LOOP_STEERS,
  reachableBudget,
  shouldSteerLoop,
  shouldWarnBudget,
  STEER_SPACING,
  stepsLeft,
  WARN_AT_FRACTION,
  warnWithin,
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
//
// The loop's own arithmetic, replayed: extension first, then the warning, in
// the order index.ts does them. Simulated rather than asserted because what was
// wrong before was the INTERACTION of the two — a run could be congratulated
// for producing new work and told to stop exploring in the same message.

const sig = (n: number) => callSignature('Edit', { file_path: `f${n}.ts` })
const varied = (n: number) => [...Array(n).keys()].map(sig)
const stuck = (n: number) =>
  [...Array(n).keys()].map(() => callSignature('BrowserReadPage', {}))

interface Beat {
  turn: number
  budget: number
  extended: number
  warnedLeft: number | null
}

/** `productive` decides what the run's recent calls look like at each turn. */
function replay(
  initial: number,
  productive: (turn: number) => boolean,
): Beat[] {
  const beats: Beat[] = []
  let budget = initial
  let extensionsUsed = 0
  let warnedFor: number | null = null
  for (let turn = 0; turn < budget; turn++) {
    const signatures = productive(turn) ? varied(12) : stuck(12)
    let extended = 0
    const extra = extensionFor({
      turnsDone: turn + 1,
      budget,
      extensionsUsed,
      signatures,
    })
    if (extra > 0) {
      budget += extra
      extensionsUsed++
      extended = extra
    }
    const state = {
      turnIndex: turn,
      budget,
      initialBudget: initial,
      extensionsUsed,
      signatures,
      warnedFor,
    }
    let warnedLeft: number | null = null
    if (shouldWarnBudget(state)) {
      warnedLeft = Math.max(0, reachableBudget(state) - (turn + 1))
      warnedFor = budget
    }
    if (extended || warnedLeft !== null)
      beats.push({ turn, budget, extended, warnedLeft })
  }
  return beats
}

{
  // THE CASE THIS EXISTS FOR. A run doing new work every turn must not be told
  // to stop exploring while it still has fifty steps coming.
  const beats = replay(40, () => true)
  const warns = beats.filter((b) => b.warnedLeft !== null)
  check('a productive run is warned exactly once', warns.length === 1, beats)
  check(
    'and not at turn 30 of 40, which was the old bug',
    warns[0]!.turn !== 29,
    warns[0],
  )
  // Ten steps from the run's REAL end, wherever the earned ceiling puts it —
  // written against the constants so raising MAX_EXTENSIONS moves the
  // expectation with it instead of pinning a number that used to be true.
  const ceiling = 40 + MAX_EXTENSIONS * EXTENSION_TURNS
  check(
    `it lands ten steps before the run really ends (turn ${ceiling - 11} of ${ceiling})`,
    warns[0]!.turn === ceiling - 11 && warns[0]!.warnedLeft === 10,
    { got: warns[0], ceiling },
  )
  check(
    'both extensions are still granted',
    beats.filter((b) => b.extended > 0).length === MAX_EXTENSIONS,
    beats,
  )
  check(
    'and no turn both extends the budget and warns about it',
    !beats.some((b) => b.extended > 0 && b.warnedLeft !== null),
    beats.filter((b) => b.extended > 0),
  )
}

{
  // Unchanged for the runs the warning was built for: no extension is coming,
  // so three quarters IS the last stretch.
  const beats = replay(40, () => false)
  const warns = beats.filter((b) => b.warnedLeft !== null)
  check('a stuck run is still warned once', warns.length === 1, beats)
  check(
    'still at three quarters, saying ten',
    warns[0]!.turn === 29 && warns[0]!.warnedLeft === 10,
    warns[0],
  )
  check('and earns no extension', !beats.some((b) => b.extended > 0), beats)
}

{
  // Productive, then stalls: the extension is refused, so the true end arrives
  // early and the heads-up has to arrive with it rather than never.
  const beats = replay(40, (t) => t < 30)
  const warns = beats.filter((b) => b.warnedLeft !== null)
  check('a run that stalls late is still warned', warns.length === 1, beats)
  check('within the last ten steps', warns[0]!.warnedLeft! <= 10, warns[0])
}

check('the fraction is late, not early', WARN_AT_FRACTION >= 0.7)
check(
  'a budget too small to warn about does not warn',
  !shouldWarnBudget({
    turnIndex: 1,
    budget: 3,
    initialBudget: 3,
    extensionsUsed: 0,
    signatures: stuck(12),
    warnedFor: null,
  }),
)
check(
  'the window is fixed to the budget the run started with',
  warnWithin(40) === 10 && warnWithin(30) === 8 && warnWithin(4) === 2,
  [warnWithin(40), warnWithin(30), warnWithin(4)],
)
check(
  'reachable counts the extensions a productive run will earn',
  reachableBudget({ budget: 40, extensionsUsed: 0, signatures: varied(12) }) ===
    40 + MAX_EXTENSIONS * EXTENSION_TURNS,
)
check(
  'and none for a run that is repeating itself',
  reachableBudget({ budget: 40, extensionsUsed: 0, signatures: stuck(12) }) === 40,
)
check(
  'nor once the extensions are spent',
  reachableBudget({
    budget: 80,
    extensionsUsed: MAX_EXTENSIONS,
    signatures: varied(12),
  }) === 80,
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
  // Bounded, but the bound is no longer the instrument: a run only reaches it
  // by producing new work in EVERY window on the way, and a stuck one is
  // ended by isStuck long before. See the stuck-run block below.
  check(
    'so the ceiling is bounded, not open-ended',
    40 + MAX_EXTENSIONS * EXTENSION_TURNS <= 200,
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

// ─── ENDING A RUN THAT IS ONLY SPINNING ─────────────────────────────────
//
// The ceiling stopped a productive run and a stuck one at exactly the same
// place: 80 steps, whatever they were doing. Measured on a real transcript,
// ninety of that run's steps went on fighting a toolchain and the handoff
// fired while it was still making progress — the step COUNT was never what
// was wrong. So repetition decides in both directions: it earns room above,
// and it ends a run early here.

{
  // Every steer spent, long enough since the last for it to have landed, and
  // the window is still one call repeated.
  const stuckSigs = [...varied(6), ...stuck(12)]
  check(
    'A RUN THAT IGNORED EVERY CORRECTION IS ENDED EARLY, not carried to the ceiling',
    isStuck({ signatures: stuckSigs, steersUsed: MAX_LOOP_STEERS, sinceLastSteer: GIVE_UP_AFTER }),
  )
  check(
    '…but not while a steer is still unspent — being told once IS the correction',
    !isStuck({ signatures: stuckSigs, steersUsed: MAX_LOOP_STEERS - 1, sinceLastSteer: GIVE_UP_AFTER }),
  )
  check(
    '…nor before the last steer has had calls to take effect',
    !isStuck({ signatures: stuckSigs, steersUsed: MAX_LOOP_STEERS, sinceLastSteer: GIVE_UP_AFTER - 1 }),
  )
  check(
    'A RUN DOING NEW WORK IS NEVER ENDED THIS WAY, however long it has gone on',
    !isStuck({ signatures: varied(40), steersUsed: MAX_LOOP_STEERS, sinceLastSteer: 100 }),
  )
  const note = stuckWrapUp('RunCommand', 9)
  check('the handoff names the blocker rather than blaming the budget', /RunCommand/.test(note) && !/out of steps/i.test(note), note)
  check('…and asks for what would unblock it', /blocked on|stuck on|need/i.test(note))
}

// ─── A LONG HONEST RUN IS NOT CUT SHORT FOR BEING LONG ──────────────────

{
  let budget = 40
  let used = 0
  const sigs: string[] = []
  for (let turn = 0; turn < 200 && turn < budget; turn++) {
    sigs.push(`Tool${turn}:{}`) // new work every single turn
    const extra = extensionFor({ turnsDone: turn + 1, budget, extensionsUsed: used, signatures: sigs })
    if (extra > 0) { budget += extra; used++ }
  }
  check(
    'a run producing new work every turn reaches the full earned ceiling',
    budget === 40 + MAX_EXTENSIONS * EXTENSION_TURNS,
    budget,
  )
  // The same loop, repeating itself: it must not get past the first wall.
  let budget2 = 40
  let used2 = 0
  const sigs2: string[] = []
  for (let turn = 0; turn < 200 && turn < budget2; turn++) {
    sigs2.push('Same:{}')
    const extra = extensionFor({ turnsDone: turn + 1, budget: budget2, extensionsUsed: used2, signatures: sigs2 })
    if (extra > 0) { budget2 += extra; used2++ }
  }
  check(
    'A REPEATING RUN EARNS NOTHING — the ceiling is not what holds it back',
    budget2 === 40,
    budget2,
  )
}

console.log(
  failures === 0 ? '\nALL TURN-BUDGET CHECKS PASSED' : `\n${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

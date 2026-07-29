/**
 * Checks the routine scheduling arithmetic.
 *
 * The dangerous case here is not jitter, it is catch-up: rescheduling happens
 * immediately after a normal fire, when the stored `nextRun` is already a
 * moment in the past. Judged on time alone that looks exactly like a missed
 * run, and the routine would fire itself forever. `lastRun` is what separates
 * the two, and the "does not re-fire" checks below are the ones that matter.
 */

import {
  catchUpDecision,
  catchUpNote,
  stableJitterMs,
} from '../src/main/routines/timing.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// ─── Jitter ─────────────────────────────────────────────────────────────

const hourly = stableJitterMs('routine-a', HOUR)
check('hourly jitter is within 10% of the period', hourly >= 0 && hourly < 6 * MIN, hourly)

const daily = stableJitterMs('routine-a', DAY)
check('daily jitter is capped at 15 minutes', daily >= 0 && daily < 15 * MIN, daily)

const everyMinute = stableJitterMs('routine-a', MIN)
check('per-minute jitter stays under 6 seconds', everyMinute >= 0 && everyMinute < 6_000, everyMinute)

check(
  'jitter is stable across calls',
  stableJitterMs('routine-a', HOUR) === hourly && stableJitterMs('routine-a', HOUR) === hourly,
)
check(
  'different routines get different offsets',
  new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => stableJitterMs(id, DAY))).size >= 5,
  ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => stableJitterMs(id, DAY)),
)
check('jitter is never negative — a cron must not fire early', stableJitterMs('z', HOUR) >= 0)
check('a zero period yields no jitter', stableJitterMs('a', 0) === 0)

// The whole point: routines must not pile onto the same instant.
const spread = Array.from({ length: 40 }, (_, i) => stableJitterMs(`r${i}`, HOUR))
check(
  '40 routines on the same cron do not share one moment',
  new Set(spread).size >= 35,
  new Set(spread).size,
)

// ─── Catch-up ───────────────────────────────────────────────────────────

const now = new Date('2026-07-29T12:00:00Z')
const iso = (ms: number): string => new Date(now.getTime() + ms).toISOString()

check(
  'a run due 2 hours ago is made up',
  catchUpDecision(iso(-2 * HOUR), undefined, now, HOUR).fire,
)
check(
  'a run due in the future is not',
  !catchUpDecision(iso(HOUR), undefined, now, HOUR).fire,
)
check(
  'a routine that never ran and has no schedule is not',
  !catchUpDecision(undefined, undefined, now, HOUR).fire,
)

// The loop guard.
check(
  'a run that ALREADY happened does not re-fire',
  !catchUpDecision(iso(-1_000), iso(-900), now, HOUR).fire,
  catchUpDecision(iso(-1_000), iso(-900), now, HOUR),
)
check(
  'reason says so',
  catchUpDecision(iso(-1_000), iso(-900), now, HOUR).reason === 'already-ran',
)
check(
  'a run whose lastRun predates the due time IS made up',
  catchUpDecision(iso(-2 * HOUR), iso(-5 * HOUR), now, HOUR).fire,
)

// Staleness bound.
const old = catchUpDecision(iso(-30 * DAY), undefined, now, DAY)
check('a month-late run is not made up', !old.fire, old)
check('but its miss count is still reported', old.missed > 25, old.missed)
check('and the reason is recorded', old.reason === 'too-old', old.reason)

// Coalescing.
const five = catchUpDecision(iso(-5 * HOUR), undefined, now, HOUR)
check('five missed hourly runs collapse into one', five.fire && five.missed === 6, five)
check(
  'a single missed run reports exactly one',
  catchUpDecision(iso(-90 * MIN), undefined, now, HOUR).missed === 2,
  catchUpDecision(iso(-90 * MIN), undefined, now, HOUR),
)

// Robustness.
check(
  'a corrupt nextRun does not fire',
  !catchUpDecision('not-a-date', undefined, now, HOUR).fire,
)
check(
  'an unknown period still yields at least one miss',
  catchUpDecision(iso(-2 * HOUR), undefined, now, 0).missed === 1,
)

// ─── Note text ──────────────────────────────────────────────────────────

check('a single miss reads as singular', !catchUpNote(1, iso(-HOUR)).includes('stands in for'))
check('several misses say how many', catchUpNote(6, iso(-6 * HOUR)).includes('6'))

console.log(failures === 0 ? '\nALL ROUTINE TIMING CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Checks how a turn's tool calls are grouped for parallel execution.
 *
 * The whole point is a speed-up, so the temptation is to test only that things
 * DO group. The dangerous half is the opposite: an unsafe call must stay a
 * barrier. `Edit` after `Write` on the same file has to see the write, and the
 * read-before-edit cache must not be raced — so a batch may never reach across
 * an unsafe call, no matter how many safe ones sit on either side.
 */

import {
  hasParallelism,
  MAX_PARALLEL,
  planBatches,
  runBatches,
  type BatchableCall,
} from '../src/main/agent/tool-batching.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

/** Read/Grep/Glob are safe; Write/Edit/Bash are not — as the real tools say. */
const SAFE = new Set(['Read', 'Grep', 'Glob', 'ReadMediaFile'])
const lookup = (name: string) =>
  name === 'Unknown'
    ? undefined
    : { name, isConcurrencySafe: (): boolean => SAFE.has(name) }

let n = 0
const call = (name: string): BatchableCall => ({
  id: `t${++n}`,
  name,
  input: {},
})

const shape = (batches: BatchableCall[][]): string =>
  batches.map((b) => b.map((c) => c.name).join('+')).join(' | ')

// ─── Grouping ───────────────────────────────────────────────────────────

check('nothing in, nothing out', planBatches([], lookup).length === 0)

const allReads = planBatches([call('Read'), call('Read'), call('Read')], lookup)
check('consecutive safe calls form ONE batch', allReads.length === 1, shape(allReads))
check('and it says it is parallel', hasParallelism(allReads))

const mixed = planBatches(
  [call('Read'), call('Grep'), call('Write'), call('Read'), call('Read')],
  lookup,
)
check(
  'an unsafe call splits the batches',
  shape(mixed) === 'Read+Grep | Write | Read+Read',
  shape(mixed),
)

const onlyWrites = planBatches([call('Write'), call('Edit'), call('Bash')], lookup)
check(
  'unsafe calls each run alone',
  shape(onlyWrites) === 'Write | Edit | Bash',
  shape(onlyWrites),
)
check('and that plan has no parallelism', !hasParallelism(onlyWrites))

// The barrier property, stated directly: Write must never share a batch with
// anything, and everything before it must finish first.
const barrier = planBatches(
  [call('Read'), call('Write'), call('Read')],
  lookup,
)
check(
  'a write is a barrier, not a batch member',
  barrier.length === 3 && barrier[1]!.length === 1 && barrier[1]![0]!.name === 'Write',
  shape(barrier),
)

// ─── Order ──────────────────────────────────────────────────────────────

const ordered = planBatches(
  [call('Read'), call('Write'), call('Grep'), call('Edit')],
  lookup,
)
check(
  'the original order survives flattening',
  ordered.flat().map((c) => c.name).join(',') === 'Read,Write,Grep,Edit',
  ordered.flat().map((c) => c.name),
)
check(
  'every call appears exactly once',
  ordered.flat().length === 4 && new Set(ordered.flat().map((c) => c.id)).size === 4,
)

// ─── The cap ────────────────────────────────────────────────────────────

const many = planBatches(
  Array.from({ length: 20 }, () => call('Read')),
  lookup,
)
check(
  'a long run of safe calls is capped, not unbounded',
  many.every((b) => b.length <= MAX_PARALLEL),
  many.map((b) => b.length),
)
check('and nothing is dropped by the capping', many.flat().length === 20)

const tight = planBatches(
  Array.from({ length: 5 }, () => call('Read')),
  lookup,
  2,
)
check(
  'the cap is configurable',
  tight.map((b) => b.length).join(',') === '2,2,1',
  tight.map((b) => b.length),
)

// ─── Unknown tools ──────────────────────────────────────────────────────

const unknown = planBatches([call('Read'), call('Unknown'), call('Read')], lookup)
check(
  'a tool we cannot look up is treated as unsafe',
  shape(unknown) === 'Read | Unknown | Read',
  shape(unknown),
)

// A tool whose own check throws has not said yes.
const throwing = (name: string) => ({
  name,
  isConcurrencySafe: (): boolean => {
    throw new Error('boom')
  },
})
const exploded = planBatches([call('Read'), call('Boom')], (name) =>
  name === 'Boom' ? throwing(name) : lookup(name),
)
check(
  'a tool that throws while answering is treated as unsafe',
  shape(exploded) === 'Read | Boom',
  shape(exploded),
)

// ─── Execution ──────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

// Results must follow CALL order, not completion order. Deliberately finish
// the batch backwards: the first call takes longest.
{
  const first = call('Read')
  const second = call('Read')
  const third = call('Read')
  const plan = planBatches([first, second, third], lookup)

  // Finish backwards: the FIRST call takes longest, so completion order is
  // third, second, first. Anything collecting results as they land would
  // return them in exactly that (wrong) order.
  const delay: Record<string, number> = {
    [first.id]: 60,
    [second.id]: 30,
    [third.id]: 1,
  }
  const completed: string[] = []
  const { results } = await runBatches(plan, async (c) => {
    await sleep(delay[c.id]!)
    completed.push(c.id)
    return c.id
  })

  check(
    'the test really did complete out of order',
    completed.join(',') === `${third.id},${second.id},${first.id}`,
    completed,
  )
  check(
    'but results follow CALL order',
    results.join(',') === `${first.id},${second.id},${third.id}`,
    results,
  )
  check('nothing is lost', results.length === 3, results)
}

// A batch really does overlap: three 60ms calls in one batch must finish in
// well under the 180ms they would take one at a time.
{
  const plan = planBatches([call('Read'), call('Read'), call('Read')], lookup)
  const started = Date.now()
  await runBatches(plan, async () => {
    await sleep(60)
    return 1
  })
  const elapsed = Date.now() - started
  check('a batch runs concurrently, not serially', elapsed < 150, `${elapsed}ms`)
}

// And an unsafe call really is serial: three of them must NOT overlap.
{
  const plan = planBatches([call('Write'), call('Write'), call('Write')], lookup)
  let inFlight = 0
  let maxInFlight = 0
  await runBatches(plan, async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(10)
    inFlight--
    return 1
  })
  check('unsafe calls never overlap', maxInFlight === 1, maxInFlight)
}

// Concurrency within a batch is bounded by the plan, so the cap is real at
// run time and not just in the shape of the plan.
{
  const plan = planBatches(
    Array.from({ length: 20 }, () => call('Read')),
    lookup,
  )
  let inFlight = 0
  let maxInFlight = 0
  await runBatches(plan, async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(5)
    inFlight--
    return 1
  })
  check(
    'no more than the cap run at once',
    maxInFlight <= MAX_PARALLEL,
    maxInFlight,
  )
}

// Abort stops before the NEXT batch; a batch already in flight is allowed to
// finish, because its tools have side effects that cannot be unwound.
{
  const plan = planBatches(
    [call('Read'), call('Write'), call('Read')],
    lookup,
  )
  let ran = 0
  const { results, aborted } = await runBatches(
    plan,
    async () => {
      ran++
      return ran
    },
    () => ran >= 1,
  )
  check('abort is reported', aborted)
  check('and it stops after the batch in flight', ran === 1, ran)
  check('partial results are still returned', results.length === 1, results)
}

console.log(failures === 0 ? '\nALL BATCHING CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

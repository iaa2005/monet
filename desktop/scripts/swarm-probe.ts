/**
 * Checks the swarm's scheduling and its report.
 *
 * The two limits guard different things and both are easy to get wrong in a
 * way nothing notices: concurrency bounds how many agents are ALIVE (each is a
 * paid model loop), the stagger bounds how fast they START (a pool alone opens
 * every slot in the same millisecond and the provider answers with 429s). So
 * the tests count in-flight tasks and measure gaps between starts, rather than
 * trusting the options were read.
 *
 * And one item failing must not lose the other nineteen reports.
 */

import { runSwarm } from '../src/main/agent/swarm-pool.js'
import { buildSwarmReport, ITEM_PLACEHOLDER, MAX_ITEMS } from '../src/main/agent/swarm-pool.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `item-${i}`)
const noStagger = { concurrency: 4, staggerMs: 0, burst: 99 }

// ─── Results ────────────────────────────────────────────────────────────

{
  // Finish backwards, so completion order is the reverse of call order.
  const out = await runSwarm(
    items(5),
    async (item, i) => {
      await sleep((5 - i) * 12)
      return `did ${item}`
    },
    noStagger,
  )
  check('every item produces an outcome', out.length === 5)
  check(
    'outcomes are in ITEM order, not completion order',
    out.map((o) => o.item).join(',') === items(5).join(','),
    out.map((o) => o.item),
  )
  check('and the index matches the position', out.every((o, i) => o.index === i))
  check('values come through', out[0]!.value === 'did item-0', out[0])
}

// ─── One failure must not sink the batch ────────────────────────────────

{
  const out = await runSwarm(
    items(5),
    async (item, i) => {
      if (i === 2) throw new Error('that one broke')
      return `ok ${item}`
    },
    noStagger,
  )
  check('a thrown item is captured, not propagated', out.length === 5)
  check('the failure is recorded on ITS item', out[2]!.error === 'that one broke', out[2])
  check('the other four still have their reports', out.filter((o) => o.value).length === 4)
  check('a failed item carries no value', out[2]!.value === undefined)
}

// ─── Concurrency ────────────────────────────────────────────────────────

{
  let inFlight = 0
  let peak = 0
  await runSwarm(
    items(12),
    async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(15)
      inFlight--
      return 1
    },
    { concurrency: 3, staggerMs: 0, burst: 99 },
  )
  check('never more alive than the limit', peak <= 3, peak)
  check('and it does use the whole limit', peak === 3, peak)
}

{
  // Fewer items than workers must not spin up idle workers or hang.
  let peak = 0
  let inFlight = 0
  const out = await runSwarm(
    items(2),
    async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight--
      return 1
    },
    { concurrency: 8, staggerMs: 0, burst: 99 },
  )
  check('two items with room for eight run both', out.length === 2 && peak === 2, peak)
}

// ─── Stagger ────────────────────────────────────────────────────────────

{
  const starts: number[] = []
  const t0 = Date.now()
  await runSwarm(
    items(5),
    async () => {
      starts.push(Date.now() - t0)
      await sleep(1)
      return 1
    },
    { concurrency: 5, staggerMs: 40, burst: 2 },
  )
  check('the burst starts without waiting', starts.length === 5 && starts[1]! < 30, starts)
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!)
  const staggered = gaps.slice(1) // gaps after the burst
  check(
    'starts past the burst are spaced out',
    staggered.every((g) => g >= 30),
    { starts, gaps },
  )
  check(
    'and the whole run took at least the stagger implies',
    Date.now() - t0 >= 3 * 40 - 20,
    Date.now() - t0,
  )
}

{
  // staggerMs: 0 must actually disable it, not wait 0ms per start in series.
  const t0 = Date.now()
  await runSwarm(items(6), async () => sleep(5), {
    concurrency: 6,
    staggerMs: 0,
    burst: 0,
  })
  check('a zero stagger really is off', Date.now() - t0 < 60, Date.now() - t0)
}

// ─── Abort ──────────────────────────────────────────────────────────────

{
  let ran = 0
  let aborted = false
  const out = await runSwarm(
    items(10),
    async () => {
      ran++
      if (ran >= 2) aborted = true
      await sleep(5)
      return 1
    },
    { concurrency: 1, staggerMs: 0, burst: 99, isAborted: () => aborted },
  )
  check('abort stops starting new work', ran < 10, ran)
  check('but the caller still gets one outcome per item', out.length === 10)
  check(
    'unstarted items are marked, never left undefined',
    out.every((o) => o !== undefined && (o.value !== undefined || o.error !== undefined)),
  )
}

// ─── Progress ───────────────────────────────────────────────────────────

{
  const seen: string[] = []
  await runSwarm(
    items(4),
    async (_i, idx) => {
      if (idx === 1) throw new Error('x')
      return 1
    },
    {
      ...noStagger,
      onSettled: (done, total, fails) => seen.push(`${done}/${total}:${fails}`),
    },
  )
  check('progress fires once per item', seen.length === 4, seen)
  check('the final tick is complete', seen[3]!.startsWith('4/4'), seen)
  check('and failures are counted', seen[3]!.endsWith(':1'), seen)
}

// ─── The report ─────────────────────────────────────────────────────────

{
  const report = buildSwarmReport([
    { index: 0, item: 'a.ts', value: 'looks fine' },
    { index: 1, item: 'b.ts', error: 'timed out' },
    { index: 2, item: 'c.ts', value: 'needs work' },
  ])
  check('the report leads with the tally', report.startsWith('Swarm finished: 2 of 3'), report.split('\n')[0])
  check('every item is named', ['a.ts', 'b.ts', 'c.ts'].every((i) => report.includes(i)))
  check('successes carry their text', report.includes('looks fine') && report.includes('needs work'))
  check('a failure is marked FAILED with the reason', report.includes('FAILED: timed out'))
  // The part that matters: a partial batch must not read as done.
  check(
    'a partial batch says so explicitly',
    /1 item\(s\) failed/.test(report) && /NOT done/.test(report),
    report.slice(-200),
  )

  const clean = buildSwarmReport([{ index: 0, item: 'a', value: 'ok' }])
  check('a clean run adds no warning', !/failed/i.test(clean), clean)
}

check('the placeholder is what the prompt advertises', ITEM_PLACEHOLDER === '{{item}}')
check('the item ceiling is a sane number', MAX_ITEMS >= 10 && MAX_ITEMS <= 100, MAX_ITEMS)

console.log(failures === 0 ? '\nALL SWARM CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

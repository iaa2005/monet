/**
 * The sessions list remembers how it was set up.
 *
 * It did not: the filters were a `useState` in App, so every launch put
 * the list back to "all, ungrouped, by recency". Somebody who prefers the
 * compact rows sets that once, not once a day.
 *
 * Two things are worth pinning. That a round trip survives — which is the
 * feature — and that a value the app does not recognise costs ONE field
 * rather than the whole set: a filter file written by an older build, or
 * edited by hand, should not leave the list sorted by a mode that no
 * longer exists.
 *
 *   npm run smoke:filters
 */

// A renderer module in a Node probe: localStorage is the one browser API
// it touches, so it gets a real one rather than a mock of the code under
// test.
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
} as Storage

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(
      `FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    )
  }
}

const { loadFilters, saveFilters, DEFAULT_FILTERS } = await import(
  '../src/renderer/components/session-filters.js'
)

// ─── Nothing saved yet ──────────────────────────────────────────────────

{
  const first = loadFilters()
  check('a fresh install gets the defaults', first.view === 'full', first)
  check('…and shows every session', first.status === 'all', first.status)
}

// ─── The round trip ─────────────────────────────────────────────────────

{
  saveFilters({ ...DEFAULT_FILTERS, view: 'compact', group: 'date' })
  const back = loadFilters()
  check('a compact list is still compact next launch', back.view === 'compact')
  check('…and it did not forget the rest', back.group === 'date', back)

  saveFilters({ ...back, view: 'full' })
  check('switching back sticks too', loadFilters().view === 'full')
}

// ─── Junk in storage ────────────────────────────────────────────────────

{
  store.set(
    'monet.session-filters',
    JSON.stringify({ view: 'enormous', sort: 'vibes', group: 'date' }),
  )
  const cleaned = loadFilters()
  check(
    'an unknown view falls back rather than rendering nothing',
    cleaned.view === 'full',
    cleaned.view,
  )
  check('an unknown sort falls back too', cleaned.sort === 'recency', cleaned.sort)
  check(
    '…and the fields that WERE valid survive it',
    cleaned.group === 'date',
    cleaned.group,
  )

  store.set('monet.session-filters', '{not json')
  check('a corrupt file is not a crash', loadFilters().view === 'full')
}

console.log(failures ? `\n${failures} FAILED` : '\nSESSION FILTERS REMEMBERED')
process.exit(failures ? 1 : 0)

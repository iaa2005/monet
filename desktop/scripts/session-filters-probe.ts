/**
 * The sessions list remembers how it was set up — in a file.
 *
 * It did not remember at all: the filters were a `useState` in App, so
 * every launch put the list back to "all, ungrouped, by recency". Nobody
 * sets a filter meaning to set it once.
 *
 * They live in `<dataDir>/ui-prefs.json` now, which is the app's own
 * convention for a setting that outlives the window — and unlike
 * localStorage it does not depend on the renderer's origin, which in dev
 * carries vite's port and changes when the port does.
 *
 * Three things worth pinning: a round trip through the real file, that a
 * value the app does not recognise costs ONE field (a JSON file invites
 * hand-editing), and that saving one preference does not wipe another.
 *
 *   npm run smoke:filters
 */

import { mkdtempSync } from 'node:fs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const dataDir = mkdtempSync(join(tmpdir(), 'ui-prefs-probe-'))
const { setDataDir } = await import('../src/main/data-dir.js')
setDataDir(dataDir)

const { getUiPrefs, setUiPrefs } = await import('../src/main/app/ui-prefs.js')
const { sanitiseFilters, DEFAULT_FILTERS } = await import(
  '../src/shared/session-filters.js'
)
const { COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT } = await import(
  '../src/shared/composer-height.js'
)
const file = join(dataDir, 'ui-prefs.json')

// ─── Nothing saved yet ──────────────────────────────────────────────────

{
  const first = getUiPrefs()
  check('a fresh install gets the defaults', first.sessionFilters.view === 'full')
  check('…and shows every session', first.sessionFilters.status === 'all')
  check('…without having written a file to say so', !existsSync(file))
}

// ─── The round trip, through the real file ──────────────────────────────

{
  setUiPrefs({
    sessionFilters: { ...DEFAULT_FILTERS, view: 'compact', group: 'date' },
  })
  check('it wrote the file', existsSync(file))

  const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
    sessionFilters?: { view?: string }
  }
  check(
    'and the file says what it should — readable, not encoded',
    onDisk.sessionFilters?.view === 'compact',
    onDisk,
  )

  const back = getUiPrefs().sessionFilters
  check('a compact list is still compact next launch', back.view === 'compact')
  check('…and it did not forget the rest', back.group === 'date', back)

  setUiPrefs({ sessionFilters: { ...back, view: 'full' } })
  check('switching back sticks too', getUiPrefs().sessionFilters.view === 'full')
}

// ─── Somebody edited the file ───────────────────────────────────────────

{
  writeFileSync(
    file,
    JSON.stringify({
      sessionFilters: { view: 'enormous', sort: 'vibes', group: 'date' },
    }),
    'utf-8',
  )
  const cleaned = getUiPrefs().sessionFilters
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

  writeFileSync(file, '{not json', 'utf-8')
  check('a corrupt file is not a crash', getUiPrefs().sessionFilters.view === 'full')
}

// ─── One preference does not erase the next ─────────────────────────────

{
  writeFileSync(
    file,
    JSON.stringify({ somethingElse: { kept: true } }),
    'utf-8',
  )
  setUiPrefs({ sessionFilters: { ...DEFAULT_FILTERS, view: 'compact' } })
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  check(
    'saving the filters keeps the rest of the file',
    !!raw['somethingElse'],
    raw,
  )
}

// ─── The height the user dragged the composer to ────────────────────────
//
// Same file, same rules, and one thing of its own: null is a VALUE here
// ("go back to growing with the text"), not "nothing to save". A patch
// keyed on truthiness would make the reset the one setting that cannot be
// stored.

{
  writeFileSync(file, JSON.stringify({ sessionFilters: { view: 'compact' } }), 'utf-8')
  check('a composer nobody dragged has no height', getUiPrefs().composerHeight === null)

  setUiPrefs({ composerHeight: 320 })
  check('a dragged height comes back', getUiPrefs().composerHeight === 320)
  check(
    '…and did not cost the filters saved beside it',
    getUiPrefs().sessionFilters.view === 'compact',
  )

  setUiPrefs({ composerHeight: null })
  check(
    'and resetting it is a save, not a no-op',
    getUiPrefs().composerHeight === null,
    getUiPrefs().composerHeight,
  )

  setUiPrefs({ composerHeight: 99_999 })
  check(
    'a height taller than any screen is clamped, not honoured',
    getUiPrefs().composerHeight === COMPOSER_MAX_HEIGHT,
    getUiPrefs().composerHeight,
  )
  setUiPrefs({ composerHeight: 3 })
  check(
    '…and one too small to type in comes up to a line',
    getUiPrefs().composerHeight === COMPOSER_MIN_HEIGHT,
    getUiPrefs().composerHeight,
  )

  writeFileSync(file, JSON.stringify({ composerHeight: 'tall please' }), 'utf-8')
  check(
    'a hand-edited nonsense height means "grow with the text"',
    getUiPrefs().composerHeight === null,
    getUiPrefs().composerHeight,
  )
}

// ─── The sanitiser both sides share ─────────────────────────────────────

{
  check(
    'garbage in, defaults out',
    sanitiseFilters(null).view === 'full' &&
      sanitiseFilters('nonsense').sort === 'recency',
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nSESSION FILTERS REMEMBERED')
process.exit(failures ? 1 : 0)

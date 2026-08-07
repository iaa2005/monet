/**
 * The switches behind "how the agent works".
 *
 * Thirteen capabilities that used to be hardcoded on, now a file and a
 * settings grid. Three things have to hold or the switches lie:
 *
 *   - a fresh install behaves exactly as before (defaults = what shipped),
 *   - turning one off does not turn another off — the file is merged, not
 *     replaced, so a screen that knows about one flag cannot erase the rest,
 *   - a hand-edited file cannot switch on something that does not exist,
 *     and cannot cost more than its own line when it is malformed.
 *
 * Plus the registry itself: every card in the grid needs an id nobody else
 * has, an icon the renderer can resolve and a description that says what
 * the thing COSTS — a switch with no cost stated is a switch nobody can
 * make a decision about.
 *
 *   npm run smoke:features
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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

const dataDir = mkdtempSync(join(tmpdir(), 'features-probe-'))
const { setDataDir } = await import('../src/main/data-dir.js')
setDataDir(dataDir)

const { getFeatures, setFeatures, isFeatureOn } = await import(
  '../src/main/agent/features.js'
)
const { FEATURES, defaultFeatures, sanitiseFeatures } = await import(
  '../src/shared/agent-features.js'
)
const file = join(dataDir, 'agent-features.json')

// ─── The registry is fit to render ──────────────────────────────────────

{
  const ids = FEATURES.map((f) => f.id)
  check('every capability has a unique id', new Set(ids).size === ids.length, ids)
  check(
    'every one names an icon',
    FEATURES.every((f) => typeof f.icon === 'string' && f.icon.length > 0),
    FEATURES.filter((f) => !f.icon).map((f) => f.id),
  )
  check(
    '…and says what it does at length, not in three words',
    FEATURES.every((f) => f.description.length > 80),
    FEATURES.filter((f) => f.description.length <= 80).map((f) => f.id),
  )
  check(
    '…and what it costs',
    FEATURES.every((f) => ['free', 'tokens', 'time'].includes(f.cost)),
    FEATURES.map((f) => `${f.id}:${f.cost}`),
  )
  check(
    'the ones that were always on are still on by default',
    ['method', 'discipline', 'verify', 'judge', 'nudge', 'budget', 'lessons', 'runNotes'].every(
      (id) => FEATURES.find((f) => f.id === id)?.defaultOn === true,
    ),
    FEATURES.filter((f) => !f.defaultOn).map((f) => f.id),
  )
  check(
    'and the ones that cost a turn are opt-in',
    ['recon', 'clarify', 'review', 'smoke', 'design'].every(
      (id) => FEATURES.find((f) => f.id === id)?.defaultOn === false,
    ),
  )
}

// ─── A fresh install ────────────────────────────────────────────────────

{
  check('nothing is written until something is changed', !existsSync(file))
  check(
    'and the defaults are the registry’s',
    JSON.stringify(getFeatures()) === JSON.stringify(defaultFeatures()),
    getFeatures(),
  )
  check('the hot-path read agrees', isFeatureOn('method') === true)
}

// ─── The round trip ─────────────────────────────────────────────────────

{
  setFeatures({ method: false })
  check('it wrote the file', existsSync(file))
  check('the switch stuck', getFeatures().method === false)
  check('…and the hot-path read sees it', isFeatureOn('method') === false)
  check(
    'ONE switch off does not take the others with it',
    getFeatures().discipline === true && getFeatures().verify === true,
    getFeatures(),
  )

  setFeatures({ recon: true })
  check(
    'a second change keeps the first',
    getFeatures().method === false && getFeatures().recon === true,
    getFeatures(),
  )

  const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  check(
    'the file is readable, not encoded',
    onDisk['method'] === false && onDisk['recon'] === true,
    onDisk,
  )

  setFeatures({ method: true })
  check('and switching back sticks too', isFeatureOn('method') === true)
}

// ─── Somebody edited the file ───────────────────────────────────────────

{
  writeFileSync(
    file,
    JSON.stringify({ method: false, nonsense: true, verify: 'yes please' }),
    'utf-8',
  )
  const back = getFeatures()
  check('a real flag is honoured', back.method === false)
  check(
    'a flag that is not a boolean falls back to its default',
    back.verify === true,
    back.verify,
  )
  check(
    'and an unknown key cannot switch anything on',
    !('nonsense' in back),
    Object.keys(back),
  )

  writeFileSync(file, '{not json', 'utf-8')
  check(
    'a corrupt file costs the flags, not the run',
    JSON.stringify(getFeatures()) === JSON.stringify(defaultFeatures()),
  )
}

// ─── The sanitiser both sides share ─────────────────────────────────────

{
  check(
    'garbage in, defaults out',
    JSON.stringify(sanitiseFeatures(null)) === JSON.stringify(defaultFeatures()) &&
      JSON.stringify(sanitiseFeatures('nope')) === JSON.stringify(defaultFeatures()),
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nEVERY CAPABILITY IS A SWITCH')
process.exit(failures ? 1 : 0)

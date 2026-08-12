/**
 * Typecheck gate: desktop code must be clean, and the leak's debt may only
 * shrink.
 *
 * The leak has internal type drift (hand-reconstructed types/message.ts, newer
 * @anthropic-ai/sdk types, trimmed modules) that doesn't affect the runtime —
 * vite/esbuild strips types without checking them. While it all sat under
 * src/vendor/leaked a directory-wide exemption was enough. It stops being
 * enough the moment those files move into src/main, because then "suppressed"
 * would silently cover our own code too.
 *
 * So the exemption is per file, with a count: typecheck-debt.json records how
 * many errors each absorbed file is currently allowed. A file not listed must
 * be clean. A file over its count fails. A file UNDER its count is reported —
 * run with --update to bank the improvement. The total can only go down.
 *
 * src/anthropic was a second, directory-wide exemption while Anthropic's own
 * product code was gathered up for deletion. That tree is gone, so this file
 * is the only exemption left.
 *
 *   npm run typecheck
 *   node scripts/typecheck.mjs --update   # bank improvements / record a move
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const DEBT_FILE = 'scripts/typecheck-debt.json'
const UPDATE = process.argv.includes('--update')

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: process.platform === 'win32' },
)

const out = (r.stdout || '') + (r.stderr || '')
const errLines = out.split(/\r?\n/).filter(l => /error TS\d+:/.test(l))

const fileOf = l => l.replace(/\(.*/, '').replace(/\\/g, '/')
const counts = new Map()
for (const l of errLines) {
  const f = fileOf(l)
  counts.set(f, (counts.get(f) ?? 0) + 1)
}

const debt = existsSync(DEBT_FILE)
  ? JSON.parse(readFileSync(DEBT_FILE, 'utf8'))
  : {}

const unlisted = [] // our code, or a newly-broken absorbed file
const regressed = []
const improved = []
for (const [f, c] of counts) {
  const allowed = debt[f] ?? 0
  if (allowed === 0) unlisted.push([f, c])
  else if (c > allowed) regressed.push([f, c, allowed])
  else if (c < allowed) improved.push([f, c, allowed])
}
// A file that WAS in debt and now reports nothing has been cleaned.
for (const f of Object.keys(debt)) if (!counts.has(f)) improved.push([f, 0, debt[f]])

if (UPDATE) {
  const next = {}
  for (const [f, c] of [...counts].sort()) {
    // Only absorbed files get an entry — anything under src/main that never
    // came from the leak must be clean, and silently granting it debt here is
    // exactly what this file exists to prevent. New entries need a reason, so
    // they are accepted only when the file already carried debt or the debt
    // file is being seeded (empty).
    const seeding = Object.keys(debt).length === 0
    if (seeding || f in debt) next[f] = c
  }
  writeFileSync(DEBT_FILE, JSON.stringify(next, null, 2) + '\n')
  const before = Object.values(debt).reduce((a, b) => a + b, 0)
  const after = Object.values(next).reduce((a, b) => a + b, 0)
  console.log(
    `debt: ${before} -> ${after} across ${Object.keys(next).length} files` +
      (after > before ? '  (WENT UP — check this is a move, not a regression)' : ''),
  )
  process.exit(0)
}

for (const [f, c] of unlisted)
  for (const l of errLines.filter(x => fileOf(x) === f)) console.error(l)
for (const [f, c, allowed] of regressed)
  console.error(`${f}: ${c} type errors, ${allowed} allowed — new errors in absorbed code`)

const debtTotal = [...counts]
  .filter(([f]) => debt[f])
  .reduce((n, [, c]) => n + c, 0)
if (debtTotal)
  console.error(`(${debtTotal} recorded type errors in code absorbed from the leak — ${DEBT_FILE})`)
if (improved.length) {
  const won = improved.reduce((n, [, c, a]) => n + (a - c), 0)
  console.error(`${improved.length} file(s) improved by ${won} errors — run: node scripts/typecheck.mjs --update`)
}

if (unlisted.length || regressed.length) {
  const n = unlisted.reduce((a, [, c]) => a + c, 0) + regressed.length
  console.error(`\ntypecheck FAILED: ${n} error(s) outside the recorded debt`)
  process.exit(1)
}

// package.json duplicate keys — invisible to JSON.parse (the last one wins),
// so a new script can silently shadow an existing one. That happened: a
// second "smoke:podman" took the name and the original probe stopped being
// runnable at all, with nothing failing to say so. A text scan, because a
// parsed object has already thrown the evidence away.
{
  const pkg = readFileSync('package.json', 'utf8')
  const seen = new Set()
  const dupes = new Set()
  for (const m of pkg.matchAll(/^(\s*)"([^"]+)"\s*:/gm)) {
    const key = `${m[1].length}:${m[2]}`
    if (seen.has(key)) dupes.add(m[2])
    seen.add(key)
  }
  if (dupes.size) {
    console.error(
      `\npackage.json has duplicate keys: ${[...dupes].join(', ')} —` +
        ' the later one silently wins',
    )
    process.exit(1)
  }
}

console.log('typecheck OK: desktop code clean')

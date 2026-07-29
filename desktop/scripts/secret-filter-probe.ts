/**
 * Checks that a search can never hand the model a secret.
 *
 * Two halves, because two things can be wrong independently:
 *   1. `isSensitivePath` — does the classifier agree with intuition?
 *   2. The real ripgrep — do the globs we append actually exclude those files,
 *      and, just as important, do they leave everything else alone?
 *
 * Half 2 is the reason this file exists. The first version of the filter added
 * a positive glob to re-include `.env.example`; ripgrep treats any positive
 * glob as an allow-list, so a plain `app.ts` match vanished from the results.
 * Reading the code did not show that. Running it did.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { GREP_EXCLUSION_SUFFIX, isSensitivePath } from '../src/main/agent/secret-filter.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── 1. Classifier ──────────────────────────────────────────────────────

const SECRET = [
  '.env',
  'sub/.env',
  '.env.local',
  '.env.production',
  'config/app.env',
  'sub/id_rsa',
  'keys/id_ed25519',
  'certs/server.pem',
  'certs/bundle.p12',
  '.netrc',
  '.npmrc',
  '.aws/credentials',
  'C:\\Users\\me\\.ssh\\id_rsa',
]
for (const p of SECRET) check(`sensitive: ${p}`, isSensitivePath(p), p)

const SAFE = [
  'app.ts',
  'src/env.ts',
  'environment.md',
  '.env.example',
  '.env.sample',
  'docs/.env.template',
  'README.md',
  'package.json',
]
for (const p of SAFE) check(`not sensitive: ${p}`, !isSensitivePath(p), p)

// ─── 2. Real ripgrep ────────────────────────────────────────────────────

let rgOk = true
try {
  execFileSync('rg', ['--version'], { stdio: 'pipe' })
} catch {
  rgOk = false
}

if (!rgOk) {
  console.log('SKIP  ripgrep half — `rg` is not on PATH')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'secret-filter-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  const NEEDLE = 'SUPERSECRET123'
  writeFileSync(join(dir, '.env'), `API_KEY=${NEEDLE}\n`)
  writeFileSync(join(dir, 'sub', '.env.production'), `API_KEY=${NEEDLE}\n`)
  writeFileSync(join(dir, '.env.example'), `API_KEY=${NEEDLE}\n`)
  writeFileSync(join(dir, 'sub', 'id_rsa'), `PRIVATE KEY ${NEEDLE}\n`)
  writeFileSync(join(dir, 'server.pem'), `CERT ${NEEDLE}\n`)
  writeFileSync(join(dir, 'app.ts'), `const key = "${NEEDLE}"\n`)
  writeFileSync(join(dir, 'notes.md'), `see ${NEEDLE} in the env file\n`)

  const run = (extraGlobs: string[]): string[] => {
    // Mirrors the vendor GrepTool's own arguments: --hidden, VCS excluded.
    const args = ['--hidden', '--glob', '!.git', '--max-columns', '500']
    for (const g of extraGlobs) args.push('--glob', g)
    args.push(NEEDLE, dir)
    try {
      const out = execFileSync('rg', args, { encoding: 'utf8', stdio: 'pipe' })
      return out.trim().split('\n').filter(Boolean)
    } catch {
      return [] // rg exits 1 when nothing matches
    }
  }

  const globs = GREP_EXCLUSION_SUFFIX.split(' ').filter(Boolean)

  const before = run([])
  check(
    'the leak is real without the filter',
    before.some((l) => l.includes('.env')) && before.some((l) => l.includes('id_rsa')),
    before.length,
  )

  const after = run(globs)
  const joined = after.join('\n')

  check('no .env content survives', !/[/\\]\.env(\W|$)/m.test(joined), after)
  check('no .env.production content survives', !joined.includes('.env.production'), after)
  check('no private key content survives', !joined.includes('id_rsa'), after)
  check('no certificate content survives', !joined.includes('server.pem'), after)

  // The regression the first version shipped: exclusions must not turn into an
  // allow-list and swallow ordinary files.
  check('ordinary source file still matches', joined.includes('app.ts'), after)
  check('ordinary markdown still matches', joined.includes('notes.md'), after)
  check(
    'exactly the two ordinary files remain',
    after.length === 2,
    after,
  )

  // A model-supplied glob has to keep working alongside ours.
  const scoped = run(['*.ts', ...globs])
  check(
    "the model's own glob still narrows the search",
    scoped.length === 1 && scoped[0]!.includes('app.ts'),
    scoped,
  )

  // Guard the invariant directly, so a future edit that adds a positive
  // pattern fails here instead of silently hiding the repo.
  check(
    'every appended glob is negated',
    globs.every((g) => g.startsWith('!')),
    globs.filter((g) => !g.startsWith('!')),
  )

  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL SECRET-FILTER CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Typecheck gate: desktop code (src/main, src/preload, src/renderer) must be
 * clean. Two trees are exempt, and they are exempt for different reasons.
 *
 * src/vendor/leaked is the leak as it arrived — internal type drift
 * (hand-reconstructed types/message.ts, newer @anthropic-ai/sdk types, trimmed
 * modules) that doesn't affect the runtime, since vite/esbuild strips types
 * without checking them. It shrinks as the tree is absorbed.
 *
 * src/anthropic is the quarantine: Anthropic's own product code, gathered so
 * its edges are visible and it can eventually go. Absorbing it properly would
 * mean fixing type errors in code we intend to delete.
 *
 * Both counts are printed separately, because the point is to watch them fall.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '--noEmit', '-p', 'tsconfig.json'],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: process.platform === 'win32' },
)

const out = (r.stdout || '') + (r.stderr || '')
const errLines = out.split(/\r?\n/).filter(l => /error TS\d+:/.test(l))
const path = l => l.replace(/\\/g, '/')
const isVendor = l => path(l).startsWith('src/vendor/leaked/')
const isQuarantine = l => path(l).startsWith('src/anthropic/')
const own = errLines.filter(l => !isVendor(l) && !isQuarantine(l))
const vendor = errLines.filter(isVendor).length
const quarantine = errLines.filter(isQuarantine).length

for (const l of own) console.error(l)
if (vendor) console.error(`(suppressed ${vendor} type errors inside src/vendor/leaked — leak-internal drift)`)
if (quarantine) console.error(`(suppressed ${quarantine} type errors inside src/anthropic — the quarantine, headed for deletion)`)

if (own.length) {
  console.error(`\ntypecheck FAILED: ${own.length} error(s) in desktop code`)
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

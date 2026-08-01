/**
 * Typecheck gate: desktop code (src/main, src/preload, src/renderer) must be
 * clean. Errors inside src/vendor/leaked are reported as a count only — the
 * leak has internal type drift (hand-reconstructed types/message.ts, newer
 * @anthropic-ai/sdk types, trimmed modules) that doesn't affect the runtime:
 * vite/esbuild strips types without checking them.
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
const isVendor = l => l.replace(/\\/g, '/').startsWith('src/vendor/leaked/')
const own = errLines.filter(l => !isVendor(l))
const vendor = errLines.length - own.length

for (const l of own) console.error(l)
if (vendor) console.error(`(suppressed ${vendor} type errors inside src/vendor/leaked — leak-internal drift)`)

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

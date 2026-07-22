/**
 * Bundles a renderer-side probe (store / lib code + zustand) for Node and runs
 * it. Those modules only touch window.electronAPI, which each probe stubs.
 *
 *   node scripts/renderer-probe.mjs scripts/retry-probe.ts
 */
import { resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'

const probe = process.argv[2]
if (!probe) {
  console.error('usage: node scripts/renderer-probe.mjs <probe.ts>')
  process.exit(2)
}
const name = basename(probe, '.ts')

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: [{ find: '@', replacement: resolve('src/renderer') }],
  },
  build: {
    ssr: true,
    // The probes use top-level await; the default browser target rejects it.
    target: 'node20',
    outDir: 'out-probe',
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: resolve(probe),
      output: { entryFileNames: `${name}.mjs`, format: 'es' },
    },
  },
})

const r = spawnSync(process.execPath, [resolve('out-probe', `${name}.mjs`)], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)

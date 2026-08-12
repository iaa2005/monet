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
    alias: [
      { find: '@', replacement: resolve('src/renderer') },
      // Code both processes share (e.g. how a tool execution is named) —
      // kept in sync with electron.vite.config.ts and tsconfig paths.
      { find: '@shared', replacement: resolve('src/shared') },
      // @main is how the leaked tree reaches modules we have taken over. A
      // renderer probe should not normally pull main-side code, but once the
      // alias exists anywhere it must resolve everywhere, or a probe fails on
      // a hop it never asked for.
      { find: '@main', replacement: resolve('src/main') },
      { find: '@anthropic', replacement: resolve('src/anthropic') },
      // Some probes reach main-side leaf modules (the checkpoint store, the
      // file ledger) that import electron for a path or two. With
      // tree-shaking off those imports survive into the bundle, so they need
      // the same stub the main-side harness uses.
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
    ],
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
      // A probe must run the code the app runs. Rollup's tree-shaking
      // propagates a parameter's value into a function when it thinks it can
      // see every caller, and a probe calling through an import namespace is
      // not counted — it rewrote `setInContext(m, inContext)` into an
      // unconditional add, and the probe duly reported that a prompt could
      // not be put back. See scripts/smoke-agent.mjs for the whole story.
      treeshake: false,
    },
  },
})

const r = spawnSync(process.execPath, [resolve('out-probe', `${name}.mjs`)], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)

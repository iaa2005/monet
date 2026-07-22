/**
 * Bundles scripts/retry-probe.ts (renderer store + zustand) for Node and runs
 * it. The store only touches window.electronAPI, which the probe stubs.
 */
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'

await build({
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: [{ find: '@', replacement: resolve('src/renderer') }],
  },
  build: {
    ssr: true,
    // The probe uses top-level await; the default browser target rejects it.
    target: 'node20',
    outDir: 'out-retry',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: resolve('scripts/retry-probe.ts'),
      output: { entryFileNames: 'retry-probe.mjs', format: 'es' },
    },
  },
})

const r = spawnSync(process.execPath, [resolve('out-retry/retry-probe.mjs')], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)

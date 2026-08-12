/**
 * Bundles a renderer-side probe (store / lib code + zustand) for Node and runs
 * it. Those modules only touch window.electronAPI, which each probe stubs.
 *
 *   node scripts/renderer-probe.mjs scripts/retry-probe.ts
 */
import { resolve, basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'

/**
 * The same package stubs the app builds with.
 *
 * Read from the same file electron.vite.config.ts reads, rather than listed
 * again here: a probe whose alias table drifts from the app's does not report
 * a failure, it fails to BUILD — and a build error reads as "this probe is
 * broken", which is how smoke:skillbridge sat red without being about skills
 * at all. It reached the command registry, the registry reaches the absorbed
 * /init, and that asks a cloud SDK for a token count.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pkgStubAliases = Object.entries(
  JSON.parse(readFileSync(resolve('pkg-stub-aliases.json'), 'utf8')),
).map(([pkg, stub]) => ({
  find: new RegExp(`^${escapeRe(pkg)}(/.*)?$`),
  replacement: resolve(stub),
}))

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
      // Some probes reach main-side leaf modules (the checkpoint store, the
      // file ledger) that import electron for a path or two. With
      // tree-shaking off those imports survive into the bundle, so they need
      // the same stub the main-side harness uses.
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      // The absorbed /init command asks Bun whether it is running from a
      // single-file bundle — the app's build maps it to a shim, so this must
      // too.
      { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
      ...pkgStubAliases,
    ],
  },
  // The same packages electron.vite.config.ts refuses to externalize
  // (BUNDLED_CJS_DEPS). Left external, node's ESM loader resolves their
  // extensionless internal imports against the real filesystem and throws
  // ERR_MODULE_NOT_FOUND — a probe dying on jsonc-parser's own internals.
  // `ajv` is on top of that list because a probe bundles with tree-shaking
  // OFF (see the note on treeshake below), so it reaches modules the app's
  // own build drops.
  ssr: {
    noExternal: [
      '@alcalzone/ansi-tokenize',
      'jsonc-parser',
      'vscode-jsonrpc',
      'ajv',
      'signal-exit',
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

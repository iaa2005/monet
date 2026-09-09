/**
 * Build and run the prompt measurement (scripts/measure-prompt-probe.ts).
 *
 *   npm run measure:prompt
 *
 * Same bundle the app is built from — the same vendor-require plugin, the
 * same package stubs, the same aliases — because a measurement of a
 * differently-assembled prompt measures nothing. Two things it needs that the
 * app does not: the electron stub, and better-sqlite3 redirected away from
 * its Electron-ABI binary (see scripts/node-sqlite-stub.cjs).
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'
import { build } from 'vite'
import {
  vendorRequirePlugin,
  vendorMacroDefine,
  vendorRequireBanner,
  bundledRipgrepPlugin,
} from './vendor-require-plugin.mjs'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pkgStubAliases = Object.entries(
  JSON.parse(readFileSync(resolve('pkg-stub-aliases.json'), 'utf8')),
).map(([pkg, stub]) => ({
  find: new RegExp('^' + escapeRe(pkg) + '(/.*)?$'),
  replacement: resolve(stub),
}))

await build({
  configFile: false,
  logLevel: 'warn',
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out-measure')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
      ...pkgStubAliases,
      // Kept in sync with electron.vite.config.ts, tsconfig paths and the
      // other probe runners. @shared was missing here, which is why this
      // script did not build at all.
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@main', replacement: resolve('src/main') },
    ],
  },
  build: {
    outDir: 'out-measure',
    emptyOutDir: false,
    ssr: true,
    target: 'node20',
    rollupOptions: {
      input: resolve('scripts/measure-prompt-probe.ts'),
      output: {
        entryFileNames: 'measure-prompt.mjs',
        format: 'es',
        banner: vendorRequireBanner,
      },
    },
    minify: false,
  },
  ssr: { noExternal: /^(?!node:)/, external: [] },
})

const r = spawnSync(
  process.execPath,
  ['-r', resolve('scripts/node-sqlite-stub.cjs'), resolve('out-measure/measure-prompt.mjs')],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // What main sets at startup (agent/lean-context.ts). The vendor
      // memoises that section on first build, so measuring without it would
      // report a prompt the app never sends.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  },
)
process.exit(r.status ?? 1)

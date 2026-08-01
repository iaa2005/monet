/**
 * Bundles scripts/smoke-probe.ts with the same aliases as the electron build
 * (electron itself stubbed) and runs it under plain Node. Catches import-time
 * crashes and exercises the vendor tool pipeline end-to-end.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'
import {
  vendorRequirePlugin,
  vendorRequireBanner,
  vendorMacroDefine,
  bundledRipgrepPlugin,
} from './vendor-require-plugin.mjs'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const pkgStubAliases = Object.entries(
  JSON.parse(readFileSync(resolve('pkg-stub-aliases.json'), 'utf8')),
).map(([pkg, stub]) => ({
  find: new RegExp(`^${escapeRe(pkg)}(/.*)?$`),
  replacement: resolve(stub),
}))

await build({
  configFile: false,
  logLevel: 'warn',
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out-smoke')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      // The plan store persists via better-sqlite3, whose native binary is
      // Electron-ABI — it cannot load under plain Node. Smoke tests the
      // approval contract, not persistence (plan-probe.cjs covers that).
      {
        find: /^.*\/plan\/store\.js$/,
        replacement: resolve('scripts/smoke-plan-store-stub.ts'),
      },
      // Code both processes share — kept in sync with electron.vite.config.ts,
      // tsconfig paths and renderer-probe.mjs.
      { find: '@shared', replacement: resolve('src/shared') },
      { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
      ...pkgStubAliases,
      { find: '@vendor', replacement: resolve('src/vendor/leaked') },
      { find: 'src', replacement: resolve('src/vendor/leaked') },
    ],
  },
  build: {
    ssr: true,
    outDir: 'out-smoke',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('scripts/smoke-probe.ts'),
      output: {
        entryFileNames: 'smoke-probe.mjs',
        format: 'es',
        banner: vendorRequireBanner,
      },
    },
    minify: false,
    target: 'node20',
  },
  ssr: {
    // bundle everything except node builtins so the smoke sees the same
    // module graph as the electron build
    noExternal: /^(?!node:)/,
    external: [],
  },
})

if (process.env.SMOKE_BUILD_ONLY) {
  console.log('bundled (build-only mode)')
  process.exit(0)
}

console.log('bundled; running probe...\n')
const r = spawnSync(process.execPath, ['out-smoke/smoke-probe.mjs'], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(r.status ?? 2)

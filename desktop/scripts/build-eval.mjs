/**
 * Bundles scripts/eval-agent.ts with the same aliases as the electron build
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
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out-eval')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
      ...pkgStubAliases,
      { find: '@vendor', replacement: resolve('src/vendor/leaked') },
      { find: 'src', replacement: resolve('src/vendor/leaked') },
    ],
  },
  build: {
    ssr: true,
    outDir: 'out-eval',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('scripts/eval-agent.ts'),
      output: {
        entryFileNames: 'eval-agent.mjs',
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

console.log('bundled → out-eval/eval-agent.mjs')
process.exit(0)

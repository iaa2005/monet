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
      { find: '@vendor', replacement: resolve('src/vendor/leaked') },
      { find: 'src', replacement: resolve('src/vendor/leaked') },
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

const r = spawnSync(process.execPath, [resolve('out-measure/measure-prompt.mjs')], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)

/**
 * Bundles scripts/directory-probe.ts with the electron build's aliases
 * (electron stubbed) and runs it under plain Node.
 *
 * Unlike smoke:agent this one talks to the network on purpose: it checks the
 * Directory's two catalogue clients against the real GitHub and MCP-registry
 * APIs, which is the only way to catch their schemas drifting. Opt-in —
 * `npm run probe:directory` — never part of a build.
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
  logLevel: 'error',
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out-dirprobe')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      // Code both processes share. This is the FIFTH place the alias has to
      // be repeated (electron.vite.config, tsconfig, renderer-probe,
      // smoke-agent, here) — every one of them a separate bundler config.
      { find: '@shared', replacement: resolve('src/shared') },
      { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
      ...pkgStubAliases,
      { find: '@main', replacement: resolve('src/main') },
      { find: '@anthropic', replacement: resolve('src/anthropic') },
      { find: '@vendor', replacement: resolve('src/vendor/leaked') },
      { find: 'src', replacement: resolve('src/vendor/leaked') },
    ],
  },
  build: {
    ssr: true,
    outDir: 'out-dirprobe',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('scripts/directory-probe.ts'),
      output: {
        entryFileNames: 'directory-probe.mjs',
        format: 'es',
        banner: vendorRequireBanner,
      },
    },
    minify: false,
    target: 'node20',
  },
  ssr: {
    noExternal: /^(?!node:)/,
    external: [],
  },
})

console.log('bundled; running probe...\n')
const r = spawnSync(process.execPath, ['out-dirprobe/directory-probe.mjs'], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(r.status ?? 2)

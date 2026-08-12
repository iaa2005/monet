/**
 * Bundles scripts/memory-probe.ts with the same aliases as the electron build
 * (electron itself stubbed) and runs it under plain Node. Catches import-time
 * crashes and exercises the vendor tool pipeline end-to-end.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
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
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out-memprobe')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      { find: 'electron', replacement: resolve('scripts/smoke-electron-stub.ts') },
      // data-dir.ts reads the brand's dot-folder name from @shared; without
      // this the bundle failed to resolve it and the probe never ran.
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
    outDir: 'out-memprobe',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('scripts/memory-probe.ts'),
      output: {
        entryFileNames: 'memory-probe.mjs',
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

console.log('bundled; running probe...')

const probeDir = mkdtempSync(join(tmpdir(), 'monet-memprobe-'))
const dataDir = join(probeDir, 'data')
writeFileSync(
  join(probeDir, 'monet-bootstrap.json'),
  JSON.stringify({ dataDir }),
)
const r = spawnSync(process.execPath, [resolve('out-memprobe/memory-probe.mjs')], {
  stdio: 'inherit',
  cwd: probeDir,
})
try {
  rmSync(probeDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(r.status ?? 2)

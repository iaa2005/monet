/**
 * Bundles a probe that needs BOTH the agent and the session database, and
 * runs it inside Electron.
 *
 * There were two runners and neither could do this:
 *
 *   - smoke-agent.mjs bundles the whole vendor graph with vite, and then runs
 *     it under plain Node with `electron` stubbed — so anything that opens the
 *     database dies at dlopen (better-sqlite3 is built against Electron's ABI);
 *   - build-db-probe.mjs opens the database inside Electron, but bundles with
 *     esbuild and no vendor plumbing, so importing the agent fails on twenty
 *     modules the vite config stubs.
 *
 * The seam between them is exactly where the transcript lives: a conversation
 * put back together from the durable rows, addressed by the ids the chat's
 * bubbles carry. That seam had no coverage at all, which is how a dead
 * transcript store went unnoticed for weeks.
 *
 * So: vite's module graph, Electron's runtime, real sqlite.
 *
 *   node scripts/build-agent-db-probe.mjs <probe.ts>
 *   electron out/probe/<name>.mjs
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
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

const entry = resolve(process.argv[2] ?? 'scripts/turn-toggle-probe.ts')
const name = `${basename(entry, '.ts')}.mjs`

await build({
  configFile: false,
  logLevel: 'warn',
  plugins: [vendorRequirePlugin(), bundledRipgrepPlugin('out/probe')],
  define: vendorMacroDefine,
  resolve: {
    alias: [
      // NO electron stub, and no plan-store stub: the point of this runner is
      // that both are real.
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
    outDir: 'out/probe',
    emptyOutDir: false,
    rollupOptions: {
      input: entry,
      // better-sqlite3 is a native binding: it is loaded by Electron, never
      // bundled.
      external: ['electron', 'better-sqlite3'],
      output: {
        entryFileNames: name,
        format: 'es',
        banner: vendorRequireBanner,
        // ONE chunk, and no tree-shaking — the same reasoning as
        // smoke-agent.mjs, and it is not hypothetical here. Rollup propagates
        // a parameter's value into a function when it believes it can see
        // every caller, and it does not count calls made through a dynamic
        // chunk's namespace. It rewrote `setInContext(m, inContext)` into an
        // unconditional `outOfContext.add(m)` because every call site inside
        // the chunk passed false — so the probe "proved" that a prompt could
        // not be put back into context, while the shipped build was correct.
        // A harness that rewrites the code under test reports on code nobody
        // runs.
        inlineDynamicImports: true,
      },
      treeshake: false,
    },
    minify: false,
    target: 'node20',
  },
  ssr: { noExternal: /^(?!node:)/, external: ['electron', 'better-sqlite3'] },
})

console.log('bundled; running probe under electron...\n')
const r = spawnSync('npx', ['electron', `out/probe/${name}`], {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: process.platform === 'win32',
})
process.exit(r.status ?? 2)

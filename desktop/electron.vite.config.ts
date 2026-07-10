import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import {
  vendorRequirePlugin,
  vendorMacroDefine,
  bundledRipgrepPlugin,
} from './scripts/vendor-require-plugin.mjs'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// CJS packages the vendor tree imports with VALUE named imports. Node's ESM
// loader can't synthesize those names from CJS (cjs-module-lexer misses them),
// so keeping them external crashes electron main at load with "Named export X
// not found". Excluding them from externalization makes vite bundle them with
// proper CommonJS interop. Detected via scan-cjs-named (scratchpad); keep in
// sync if the vendor tree gains new such imports.
const BUNDLED_CJS_DEPS = [
  '@alcalzone/ansi-tokenize',
  'jsonc-parser',
  'vscode-jsonrpc',
]

// Throwing stubs for Anthropic-internal / cloud-provider / native packages
// referenced by the vendor tree but never executed in the desktop build.
// Any subpath of a stubbed package maps to the same stub module (regex find —
// a string alias would splice the subpath onto the stub file path).
// Kept in sync with tsconfig.json "paths" via pkg-stub-aliases.json.
const pkgStubAliases = Object.entries(
  JSON.parse(readFileSync(resolve('pkg-stub-aliases.json'), 'utf8')) as Record<
    string,
    string
  >,
).map(([pkg, stub]) => ({
  find: new RegExp(`^${escapeRe(pkg)}(/.*)?$`),
  replacement: resolve(stub),
}))

// Vendor code imports both relative (../bootstrap/state.js) and src/-rooted
// (src/bootstrap/state.js) specifiers. Both MUST resolve to the same vendor
// files — a shim on the src/ path only would split module state (e.g. two
// sessionId stores). Only truly virtual Bun modules stay shimmed.
// Note: the Bun-style 'vscode-jsonrpc/node.js' subpath is corrected to the
// valid './node' export by vendorRequirePlugin (a file alias wouldn't apply —
// externalizeDepsPlugin keeps the package external).
const vendorAliases = [
  { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
  ...pkgStubAliases,
  { find: '@vendor', replacement: resolve('src/vendor/leaked') },
  { find: 'src', replacement: resolve('src/vendor/leaked') },
]

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: BUNDLED_CJS_DEPS }),
      vendorRequirePlugin(),
      bundledRipgrepPlugin('out/main'),
    ],
    resolve: {
      alias: vendorAliases,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Sandbox Python runs in a worker_thread so heavy computations
          // never freeze the app. Loaded via new Worker(new URL(...)).
          'pyodide-worker': resolve('src/main/sandbox/pyodide.worker.ts'),
        },
      },
    },
    // Bare `require('yaml')` etc. in vendor code paths are served by the
    // per-chunk `createRequire` shim electron-vite injects into ESM output.
    define: vendorMacroDefine,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: [
        { find: '@', replacement: resolve('src/renderer') },
        ...vendorAliases,
      ],
    },
    plugins: [react()],
    css: {
      postcss: './postcss.config.js',
    },
    // The STT worker (local Whisper via transformers.js) uses dynamic imports
    // internally — iife workers can't code-split, so emit workers as ES.
    worker: {
      format: 'es' as const,
    },
  },
})

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
// Code both processes must agree on (e.g. how a tool execution is named for
// the task log, which main writes and the renderer renders).
const sharedAlias = { find: '@shared', replacement: resolve('src/shared') }

// @main exists so the leaked tree can import OUR modules while it is being
// absorbed. The arrow used to point only one way (ours → vendor); it now
// points both, because every module that moves out leaves importers behind
// inside the tree, and a relative path from src/vendor/leaked/… is unreadable.
const mainAlias = { find: '@main', replacement: resolve('src/main') }

// The quarantine: Anthropic's own product code — their event pipeline, OAuth
// and billing, API client, terminal front-end, IDE and remote bridges. Still
// reachable, so it is still built; gathered under one root so the edges into
// it can be seen and cut. See scripts/vendor-plan-anthropic.mjs.
const anthropicAlias = { find: '@anthropic', replacement: resolve('src/anthropic') }

const vendorAliases = [
  sharedAlias,
  mainAlias,
  anthropicAlias,
  { find: 'bun:bundle', replacement: resolve('src/main/shims/bun-bundle.ts') },
  ...pkgStubAliases,
  { find: '@vendor', replacement: resolve('src/vendor/leaked') },
  { find: 'src', replacement: resolve('src/vendor/leaked') },
]

// Time-limited beta builds: `MONET_BETA_EXPIRES=2026-09-01 npm run build`
// BAKES the deadline into the bundles (a runtime env var could simply be
// unset by whoever runs the app). Empty = a normal, unlimited build.
// Date-only values are valid THROUGH that day; full ISO timestamps are exact.
const betaDefine = {
  __BETA_EXPIRES__: JSON.stringify(process.env.MONET_BETA_EXPIRES ?? ''),
}

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
          // On-device speech recognition (sherpa-onnx) runs in its own
          // process: the native module takes main down when loaded inside
          // one of its threads, and decoding blocks whatever runs it.
          'gigaam-child': resolve('src/main/stt/gigaam.child.ts'),
          // The Supertonic 3 voice: same isolation, its own onnxruntime.
          'supertonic-child': resolve('src/main/tts/supertonic.child.ts'),
          // Document OCR: a 1B vision model whose generation runs for
          // minutes. In main it would stall every IPC channel in the app.
          'ocr-child': resolve('src/main/ocr/ocr.child.ts'),
        },
      },
    },
    // Bare `require('yaml')` etc. in vendor code paths are served by the
    // per-chunk `createRequire` shim electron-vite injects into ESM output.
    define: { ...vendorMacroDefine, ...betaDefine },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: [sharedAlias] },
  },
  renderer: {
    // NOT the default 5173: Windows' WinNAT/Hyper-V (here: the Podman WSL2
    // machine) reserves dynamic port ranges, and 5173 landed inside one
    // (5162–5261 at the time of writing) — dev then dies with
    // "listen EACCES: permission denied ::1:5173" even though nothing is
    // listening. `netsh interface ipv4 show excludedportrange protocol=tcp`
    // shows the ranges; a winnat restart clears them only until the next boot,
    // so a port far outside the reserved clusters is the durable fix.
    server: { port: 17173 },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // The empty host page a popped-out dock group adopts its DOM into.
          popout: resolve('src/renderer/popout.html'),
          // A hidden window that draws PDF pages for the OCR scanner: main
          // is Node and has no canvas, Chromium is already here.
          rasterise: resolve('src/renderer/rasterise.html'),
        },
      },
    },
    resolve: {
      alias: [
        { find: '@', replacement: resolve('src/renderer') },
        ...vendorAliases,
      ],
    },
    plugins: [react()],
    define: betaDefine,
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

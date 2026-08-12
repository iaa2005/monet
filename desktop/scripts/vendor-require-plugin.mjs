/**
* The absorbed engine (built for Bun) uses lazy `require()` inside ESM modules —
 * both for cycle-breaking and feature-gated loading. In an ESM bundle that
 * crashes at call time. Two-part fix:
 *
 *  1. This plugin rewrites relative `require('./x.js')` calls inside
 *     our source tree into hoisted namespace imports (eager, cycle-safe via
 *     rollup's hoisting).
 *  2. Bare requires (`require('yaml')`, node builtins) are left alone and
 *     served by a `createRequire` banner injected into the output (see
 *     vendorRequireBanner).
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

// This used to match src/vendor/leaked. When that folder was emptied into
// src/main and src/anthropic the pattern silently stopped matching anything,
// the lazy requires were left raw, and the app died at call time with
// "Cannot find module '../utils/teammate.js'" — a runtime failure the build
// could not see. smoke:agent caught it.
//
// The scope is now OUR source tree rather than a list of the absorbed
// directories, because such a list is exactly the thing that goes stale on
// the next move. It is safe for our own files: they never use relative
// require() (ESM throughout), so the transform finds nothing and returns
// null.
//
// It must be THIS project's src, matched absolutely. A pattern of /[\/]src[\/]/
// also matches node_modules/debug/src/index.js, and rewriting that CJS
// module's requires into ESM imports destroys its module.exports shape —
// "default is not exported by debug/src/index.js", from a package nothing
// here touches directly.
const SRC_DIR = resolvePath(process.cwd(), 'src').replace(/\\/g, '/') + '/'
const inOurSource = id => id.replace(/\\/g, '/').startsWith(SRC_DIR)
const REQUIRE_RE = /(?<![.\w$])require\(\s*(['"])(\.[^'"]+)\1\s*\)/g

function moduleExists(importerDir, spec) {
  const base = resolvePath(importerDir, spec).replace(/\.js$/, '')
  return ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'].some(
    ext => existsSync(base + ext),
  )
}

export function vendorRequirePlugin() {
  return {
    name: 'vendor-relative-require',
    enforce: 'pre',
    transform(code, id) {
      if (!inOurSource(id)) return null

      let src = code
      // The Bun build imported the 'vscode-jsonrpc/node.js' subpath, but the
      // package's exports map only exposes './node' — the '.js' form crashes
      // Node's ESM resolver once externalizeDepsPlugin leaves it external.
      // Rewriting here (pre-parse) makes rollup resolve the valid subpath,
      // regardless of source reverts or externalize ordering.
      if (src.includes('vscode-jsonrpc/node.js')) {
        src = src.replace(/vscode-jsonrpc\/node\.js/g, 'vscode-jsonrpc/node')
      }

      if (!src.includes('require(')) {
        return src === code ? null : { code: src, map: null }
      }

      const importerDir = dirname(id)
      const imports = new Map() // spec -> local ident
      let counter = 0
      const rewritten = src.replace(REQUIRE_RE, (match, _q, spec, offset, whole) => {
        // Bun's bundler dead-code-eliminates `feature('X') ? require(...) :
        // null`; all flags are off in the desktop build. Hoisting such a
        // require would create import edges (and TDZ cycles) that never
        // existed — leave the call in place: the branch never executes.
        const statementStart = Math.max(
          whole.lastIndexOf(';', offset),
          whole.lastIndexOf('\n\n', offset),
          0,
        )
        if (/\bfeature\s*\(/.test(whole.slice(statementStart, offset))) {
          return match
        }
        // Requires of modules absent from the leak: same story — gated off.
        if (!moduleExists(importerDir, spec)) {
          return `(undefined /* missing vendor module: ${spec} */)`
        }
        let ident = imports.get(spec)
        if (!ident) {
          ident = `__vendorRequire${counter++}`
          imports.set(spec, ident)
        }
        return ident
      })
      if (imports.size === 0 && rewritten === code) return null

      const header = [...imports.entries()]
        .map(([spec, ident]) => `import * as ${ident} from '${spec}'`)
        .join('\n')
      return { code: header ? `${header}\n${rewritten}` : rewritten, map: null }
    },
  }
}

/** Output banner providing `require` for the remaining bare-package requires. */
export const vendorRequireBanner = [
  `import { createRequire as __createRequire } from 'node:module'`,
  `const require = __createRequire(import.meta.url)`,
].join('\n')

/**
 * Bun build-time MACRO constants (see leaked-code/macro_preload.ts) — inlined
 * via vite define, mirroring `bun build --define`.
 */
export const vendorMacroDefine = Object.fromEntries(
  Object.entries({
    VERSION: '1.0.0-leak',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: '@anthropic-ai/claude-code',
    NATIVE_PACKAGE_URL: '@anthropic-ai/claude-code',
    // User-visible in prompts and error messages ("report issues at …",
    // "post in …"), so these must name THIS product's channels — pointing
    // users at Anthropic's tracker sends bug reports to the wrong project.
    FEEDBACK_CHANNEL: 'the Code Monet issue tracker',
    ISSUES_EXPLAINER:
      'report issues at https://github.com/iaa2005/monet/issues',
    VERSION_CHANGELOG: '',
  }).map(([k, v]) => [`MACRO.${k}`, JSON.stringify(v)]),
)

/**
 * Copies the @vscode/ripgrep binary into `<outDir>/vendor/ripgrep/<arch>-<platform>/`
 * — the exact layout vendor utils/ripgrep.ts resolves relative to the bundle
 * when no system rg is found.
 */
export function bundledRipgrepPlugin(outDir) {
  return {
    name: 'bundled-ripgrep',
    apply: 'build',
    closeBundle() {
      const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
      const src = resolvePath(
        `node_modules/@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binaryName}`,
      )
      if (!existsSync(src)) {
        console.warn(`[bundled-ripgrep] ${src} not found — Grep/Glob will need system rg`)
        return
      }
      const destDir = resolvePath(
        outDir,
        'vendor',
        'ripgrep',
        process.platform === 'win32'
          ? `${process.arch}-win32`
          : `${process.arch}-${process.platform}`,
      )
      mkdirSync(destDir, { recursive: true })
      copyFileSync(src, resolvePath(destDir, binaryName))
    },
  }
}

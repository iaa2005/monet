/**
 * Standalone ripgrep executor — zero vendor dependencies.
 *
 * Wraps system `rg` (ripgrep) with timeout, abort, and EAGAIN retry.
 * Falls back to Node.js manual search if rg is not installed.
 */
import { execFile as cpExecFile, type ExecFileException } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import { getWorkspacePath } from '../ipc/workspace.js'

const execFileAsync = promisify(cpExecFile)

export interface RipgrepArgs {
  pattern: string
  path?: string
  glob?: string
  type?: string
  /** content | files_with_matches | count */
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-B'?: number
  '-A'?: number
  '-C'?: number
  '-n'?: boolean
  '-i'?: boolean
  head_limit?: number
  offset?: number
  multiline?: boolean
  /**
   * Honour .gitignore and skip dependency folders.
   *
   * Off by default, because an agent asking "where is this string" wants the
   * whole tree. On for the UI's own lookups, where speed is the point:
   * searching node_modules for a CSS class took 20 SECONDS on an ordinary
   * workspace — measured — and a browser element-pick fires nine searches.
   */
  respect_ignore?: boolean
  /** Cap for this search; defaults to RG_TIMEOUT. */
  timeout_ms?: number
}

export interface RipgrepResult {
  lines: string[]
  truncated: boolean
  truncatedAt: number
}

const RG_TIMEOUT = 20_000
const RG_MAX_BUFFER = 20_000_000

// ─── System rg detection ────────────────────────────────────────────────

let rgPath: string | null = null

/**
 * The ripgrep the BUILD ships, at `<out/main>/vendor/ripgrep/<arch>-<os>/`.
 *
 * The build has been copying it there all along and nothing ever looked: the
 * search only probed PATH, so on a machine without ripgrep installed every
 * call fell through to the manual walk below. Measured on a real workspace,
 * that walk reads about a gigabyte across twelve thousand files and does not
 * finish in eight seconds — in the MAIN process, where it freezes the whole
 * app. Picking an element in the browser fires up to nine of them.
 */
function bundledRg(): string | null {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const folder =
    process.platform === 'win32'
      ? `${process.arch}-win32`
      : `${process.arch}-${process.platform}`
  // Anchored on Electron's own paths rather than __dirname: the bundle is CJS
  // today and ESM in a probe, and a resolver that only works in one of them
  // is a resolver that will quietly stop working. (The probe caught exactly
  // that: "__dirname is not defined".)
  const roots: string[] = []
  try {
    const appPath = app.getAppPath()
    roots.push(join(appPath, 'out', 'main'), appPath)
    // Packaged: asar cannot execute a binary, so it is unpacked beside it.
    roots.push(
      join(appPath.replace('app.asar', 'app.asar.unpacked'), 'out', 'main'),
    )
    if (process.resourcesPath)
      roots.push(join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main'))
  } catch {
    /* not an Electron context (a probe) — fall through to the cwd guesses */
  }
  roots.push(join(process.cwd(), 'out', 'main'))
  const candidates = roots.map((r) => join(r, 'vendor', 'ripgrep', folder, binary))
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* keep looking */
    }
  }
  return null
}

async function findRg(): Promise<string | null> {
  if (rgPath !== null) return rgPath || null

  const bundled = bundledRg()
  if (bundled) {
    rgPath = bundled
    return rgPath
  }
  try {
    // Test if rg is available
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'rg.exe' : 'rg',
      ['--version'],
      { timeout: 3000, windowsHide: true },
    )
    if (stdout.includes('ripgrep')) {
      rgPath = process.platform === 'win32' ? 'rg.exe' : 'rg'
      return rgPath
    }
  } catch {
    rgPath = ''
  }
  return null
}

// ─── ripgrep execution ──────────────────────────────────────────────────

export async function ripGrep(
  args: RipgrepArgs,
  abortSignal?: AbortSignal,
): Promise<RipgrepResult> {
  const rg = await findRg()
  if (rg) {
    try {
      return await ripGrepNative(args, rg, abortSignal)
    } catch {
      // Fall through to manual search on any error
    }
  }
  return await ripGrepManual(args)
}

async function ripGrepNative(
  args: RipgrepArgs,
  rgExe: string,
  abortSignal?: AbortSignal,
): Promise<RipgrepResult> {
  const {
    pattern,
    path: searchPath,
    glob,
    type,
    output_mode = 'files_with_matches',
    '-B': before,
    '-A': after,
    '-C': context,
    '-n': lineNumbers = true,
    '-i': caseInsensitive = false,
    head_limit,
    offset = 0,
    multiline = false,
    respect_ignore = false,
    timeout_ms,
  } = args

  const ws = getWorkspacePath()
  const target = searchPath ? (searchPath.startsWith('/') || /^[A-Z]:/i.test(searchPath) ? searchPath : join(ws, searchPath)) : ws

  const rgArgs: string[] = respect_ignore ? ['--hidden'] : ['--hidden', '--no-ignore']

  // Exclude VCS noise
  for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
    rgArgs.push('--glob', `!${dir}`)
  }
  if (respect_ignore)
    for (const dir of ['node_modules', 'dist', 'build', 'out', '.next', 'target', 'vendor'])
      rgArgs.push('--glob', `!${dir}`)

  rgArgs.push('--max-columns', '500')

  if (multiline) rgArgs.push('-U', '--multiline-dotall')
  if (caseInsensitive) rgArgs.push('-i')

  if (output_mode === 'files_with_matches') rgArgs.push('-l')
  else if (output_mode === 'count') rgArgs.push('-c')
  else if (lineNumbers) rgArgs.push('-n')

  if (output_mode === 'content' && context !== undefined) rgArgs.push('-C', String(context))
  else if (args['-C'] !== undefined) rgArgs.push('-C', String(args['-C']))
  else {
    if (before !== undefined) rgArgs.push('-B', String(before))
    if (after !== undefined) rgArgs.push('-A', String(after))
  }

  if (pattern.startsWith('-')) rgArgs.push('-e', pattern)
  else rgArgs.push(pattern)

  if (type) rgArgs.push('--type', type)
  if (glob) {
    for (const g of glob.split(/[,\s]+/).filter(Boolean)) {
      rgArgs.push('--glob', g)
    }
  }

  rgArgs.push(target)

  const { stdout } = await execFileAsync(rgExe, rgArgs, {
    maxBuffer: RG_MAX_BUFFER,
    timeout: timeout_ms ?? RG_TIMEOUT,
    signal: abortSignal,
    windowsHide: true,
  })

  const allLines = stdout.trim().split('\n').filter(Boolean)
  const limit = head_limit ?? 250
  const effectiveOffset = offset
  const total = allLines.length

  const sliced = effectiveOffset > 0
    ? allLines.slice(effectiveOffset, effectiveOffset + limit)
    : allLines.slice(0, limit)

  return {
    lines: sliced.map(l => l.replace(/\r$/, '')),
    truncated: total > effectiveOffset + limit,
    truncatedAt: limit,
  }
}

// ─── Manual fallback (Node.js) ──────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', 'dist', 'out', '.next', 'build'])
const MANUAL_MAX = 200
/**
 * The manual walk is a fallback, not a search engine: it reads every file it
 * touches. Measured on one ordinary workspace — 12 000 files, a gigabyte, not
 * finished after eight seconds, all of it blocking the main process. A budget
 * turns "the app is gone" into "no results this time", which is a fallback
 * doing its job.
 */
const MANUAL_BUDGET_MS = 400
const MANUAL_MAX_FILE_BYTES = 512 * 1024

async function ripGrepManual(args: RipgrepArgs): Promise<RipgrepResult> {
  const {
    pattern,
    path: searchPath,
    glob: globFilter,
    output_mode = 'files_with_matches',
    '-i': caseInsensitive = false,
    head_limit,
    offset = 0,
  } = args

  const ws = getWorkspacePath()
  const target = searchPath ? (searchPath.startsWith('/') || /^[A-Z]:/i.test(searchPath) ? searchPath : join(ws, searchPath)) : ws

  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
  } catch {
    return { lines: [`Error: Invalid regex pattern: ${pattern}`], truncated: false, truncatedAt: 0 }
  }

  const incRegex = globFilter ? globToRegex(globFilter) : null
  const results: string[] = []
  const deadline = Date.now() + MANUAL_BUDGET_MS

  function search(dir: string): void {
    if (results.length >= MANUAL_MAX || Date.now() > deadline) return
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= MANUAL_MAX || Date.now() > deadline) return
        const fp = join(dir, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) search(fp)
          continue
        }
        if (incRegex && !incRegex.test(e.name)) continue
        if (e.name.startsWith('.')) continue
        try {
          // Reading a 200 MB artifact to regex it is how a fallback becomes
          // the problem it was meant to soften.
          if (statSync(fp).size > MANUAL_MAX_FILE_BYTES) continue
          const lines = readFileSync(fp, 'utf-8').split('\n')
          if (output_mode === 'files_with_matches') {
            if (lines.some(l => regex.test(l))) {
              regex.lastIndex = 0
              results.push(relative(ws, fp))
            }
          } else if (output_mode === 'count') {
            let count = 0
            for (const l of lines) if (regex.test(l)) count++
            regex.lastIndex = 0
            if (count > 0) results.push(`${relative(ws, fp)}:${count}`)
          } else {
            lines.forEach((l, i) => {
              if (regex.test(l)) {
                results.push(`${relative(ws, fp)}:${i + 1}: ${l.trim()}`)
              }
            })
            regex.lastIndex = 0
          }
        } catch { /* binary */ }
      }
    } catch { /* skip */ }
  }

  try {
    if (statSync(target).isFile()) {
      const lines = readFileSync(target, 'utf-8').split('\n')
      if (output_mode === 'files_with_matches') {
        if (lines.some(l => regex.test(l))) results.push(relative(ws, target))
      } else if (output_mode === 'count') {
        let count = 0
        for (const l of lines) if (regex.test(l)) count++
        if (count > 0) results.push(`${relative(ws, target)}:${count}`)
      } else {
        lines.forEach((l, i) => {
          if (regex.test(l)) results.push(`${relative(ws, target)}:${i + 1}: ${l.trim()}`)
        })
      }
    } else search(target)
  } catch (err) {
    return { lines: [`Error: ${err instanceof Error ? err.message : err}`], truncated: false, truncatedAt: 0 }
  }

  const limit = head_limit ?? 250
  const sliced = results.slice(offset, offset + limit)
  return {
    lines: sliced,
    truncated: results.length > offset + limit,
    truncatedAt: limit,
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$')
}

// ─── Glob (file listing via rg --files) ─────────────────────────────────

export interface GlobArgs {
  pattern: string
  path?: string
  head_limit?: number
}

export async function ripGlob(args: GlobArgs, abortSignal?: AbortSignal): Promise<RipgrepResult> {
  const { pattern, path: searchPath, head_limit } = args
  const rg = await findRg()
  const ws = getWorkspacePath()
  const target = searchPath ? (searchPath.startsWith('/') || /^[A-Z]:/i.test(searchPath) ? searchPath : join(ws, searchPath)) : ws

  if (rg) {
    try {
      const rgArgs = ['--files', '--hidden', '--no-ignore']
      for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
        rgArgs.push('--glob', `!${dir}`)
      }
      // Convert glob pattern to rg --glob
      if (pattern && pattern !== '**' && pattern !== '**/*') {
        rgArgs.push('--glob', pattern)
      }
      rgArgs.push(target)

      const { stdout } = await execFileAsync(rg, rgArgs, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: RG_TIMEOUT,
        signal: abortSignal,
        windowsHide: true,
      })

      const allLines = stdout.trim().split('\n').filter(Boolean)
      // Sort by modification time (newest first) like vendor GlobTool
      const withStats = allLines
        .map(l => ({ path: relative(ws, l).replace(/\r$/, ''), mtime: 0 }))
      try {
        for (const entry of withStats) {
          const absPath = join(ws, entry.path)
          try { entry.mtime = statSync(absPath).mtimeMs } catch { /* ignore */ }
        }
      } catch { /* ignore stat errors */ }
      withStats.sort((a, b) => b.mtime - a.mtime)

      const limit = head_limit ?? 100
      const sliced = withStats.slice(0, limit).map(e => e.path)
      return {
        lines: sliced,
        truncated: allLines.length > limit,
        truncatedAt: limit,
      }
    } catch {
      // Fall through to manual
    }
  }

  // Manual fallback
  return manualGlob(pattern, target, head_limit ?? 100)
}

function manualGlob(pattern: string, basePath: string, limit: number): RipgrepResult {
  const results: string[] = []
  const isRecursive = pattern.includes('**')
  const flatPattern = pattern.replace(/\*\*\/?/g, '')
  const globRe = globToRegex(flatPattern || '*')

  function walk(dir: string, depth: number): void {
    if (results.length >= limit * 2) return
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue
        const fp = join(dir, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && isRecursive) walk(fp, depth + 1)
          continue
        }
        if (e.name.startsWith('.')) continue
        if (globRe.test(e.name)) results.push(relative(getWorkspacePath(), fp))
      }
    } catch { /* skip */ }
  }

  walk(basePath, 0)
  const sliced = results.slice(0, limit)
  return { lines: sliced, truncated: results.length > limit, truncatedAt: limit }
}

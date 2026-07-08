/**
 * Standalone ripgrep executor — zero vendor dependencies.
 *
 * Wraps system `rg` (ripgrep) with timeout, abort, and EAGAIN retry.
 * Falls back to Node.js manual search if rg is not installed.
 */
import { execFile as cpExecFile, type ExecFileException } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { promisify } from 'util'
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

async function findRg(): Promise<string | null> {
  if (rgPath !== null) return rgPath
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
  } = args

  const ws = getWorkspacePath()
  const target = searchPath ? (searchPath.startsWith('/') || /^[A-Z]:/i.test(searchPath) ? searchPath : join(ws, searchPath)) : ws

  const rgArgs: string[] = ['--hidden', '--no-ignore']

  // Exclude VCS noise
  for (const dir of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
    rgArgs.push('--glob', `!${dir}`)
  }

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
    timeout: RG_TIMEOUT,
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

  function search(dir: string): void {
    if (results.length >= MANUAL_MAX) return
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= MANUAL_MAX) return
        const fp = join(dir, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) search(fp)
          continue
        }
        if (incRegex && !incRegex.test(e.name)) continue
        if (e.name.startsWith('.')) continue
        try {
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

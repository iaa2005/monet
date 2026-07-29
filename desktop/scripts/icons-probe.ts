/**
 * Checks that every icon the file tree can ask for actually exists on disk.
 *
 * It did not. The map pointed `.svg` at "vector" and `.ico` at "favicon" —
 * names that were never in the icon set — so those rows rendered the browser's
 * broken-image glyph. Six more were wrong the same way (scss, less, sh/bash/
 * bat, package.json, README, prettier), and nothing had noticed, because a
 * missing <img> src fails silently and looks like a design choice.
 *
 * A name that resolves to no file is the whole bug class, so the test is the
 * whole map against the whole directory.
 */

import { readdirSync } from 'fs'
import { join } from 'path'
import {
  allMappedIconNames,
  fallbackIcon,
  resolveIcon,
} from '../src/renderer/components/icon-resolver.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const ICON_ROOT = join('src', 'renderer', 'public', 'icons')
const themes = ['base', 'light'] as const

const present: Record<string, Set<string>> = {}
for (const theme of themes) {
  present[theme] = new Set(
    readdirSync(join(ICON_ROOT, theme))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4)),
  )
}

check('the icon set is not empty', present.base!.size > 100, present.base!.size)
check(
  'both themes carry the same names',
  present.base!.size === present.light!.size &&
    [...present.base!].every((n) => present.light!.has(n)),
  {
    base: present.base!.size,
    light: present.light!.size,
    onlyInBase: [...present.base!].filter((n) => !present.light!.has(n)).slice(0, 5),
  },
)

// The check that would have caught this.
const mapped = allMappedIconNames()
const missing = mapped.filter((n) => !present.base!.has(n))
check(
  `all ${mapped.length} mapped icon names exist`,
  missing.length === 0,
  missing,
)

// The specific types from the report, end to end through resolveIcon.
const cases: [string, boolean][] = [
  ['logo.svg', false],
  ['favicon.ico', false],
  ['styles.scss', false],
  ['theme.less', false],
  ['build.sh', false],
  ['run.bat', false],
  ['package.json', false],
  ['README.md', false],
  ['.prettierrc', false],
  ['logo.png', false],
  ['main.ts', false],
  ['src', true],
]
for (const [name, isDir] of cases) {
  for (const dark of [false, true]) {
    const src = resolveIcon(name, isDir, false, dark)
    const file = src.slice(src.lastIndexOf('/') + 1, -4)
    const theme = dark ? 'light' : 'base'
    if (!present[theme]!.has(file)) {
      check(`${name} (${theme}) resolves to a real file`, false, `${file}.svg is missing`)
    }
  }
}
check('every sampled filename resolves to a real icon', failures === 0)

// An unmapped extension must land on the generic file icon, not on nothing.
const unknown = resolveIcon('thing.qqq', false, false, false)
check('an unknown extension falls back to _file', unknown.endsWith('_file.svg'), unknown)

// The runtime fallback the tree uses on a load error.
check('the file fallback exists', present.base!.has('_file'))
check('the folder fallback exists', present.base!.has('_folder'))
check('the open-folder fallback exists', present.base!.has('_folder_open'))
check(
  'fallbackIcon points at the generic file icon',
  fallbackIcon(false, false, false).endsWith('_file.svg'),
  fallbackIcon(false, false, false),
)
check(
  'and at the open folder for an expanded directory',
  fallbackIcon(true, true, true).endsWith('_folder_open.svg'),
  fallbackIcon(true, true, true),
)

console.log(failures === 0 ? '\nALL ICON CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

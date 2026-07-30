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

// ── The other direction ────────────────────────────────────────────────
//
// Reported: "в дереве не все типы показываются иконки, они рисуются обычным
// файлом". Every check above asks "does this mapping point at a real icon" — and
// they all passed, because the mappings were fine. The gap was the opposite one:
// the set ships 249 icons and only 102 names could ever be asked for, so 73 FILE
// icons sat on disk unreachable and `.pdf`, `.zip`, `.txt`, `.lua`, `.vue`,
// `.tex`, fonts, audio and video all drew the generic page.
{
  // Real names, and the icon each must land on. A table, because the failure was
  // silent: a wrong icon and no icon look the same in a tree.
  const cases: [string, string][] = [
    ['tesla_tsla_tear_sheet.pdf', 'pdf'],
    ['notes.txt', 'text'],
    ['archive.zip', 'zip'],
    ['bundle.tar.gz', 'zip'],
    ['paper.tex', 'latex'],
    ['init.lua', 'lua'],
    ['App.vue', 'vue'],
    ['Card.svelte', 'svelte'],
    ['analysis.jl', 'julia'],
    ['main.nim', 'nim'],
    ['flake.nix', 'nix'],
    ['main.zig', 'zig'],
    ['script.pl', 'perl'],
    ['solver.f90', 'fortran'],
    ['boot.asm', 'assembly'],
    ['main.tf', 'terraform'],
    ['Inter.woff2', 'font'],
    ['theme.mp3', 'audio'],
    ['clip.mp4', 'video'],
    ['app.exe', 'binary'],
    ['module.wasm', 'web-assembly'],
    ['server.pem', 'key'],
    ['Makefile', 'makefile'],
    ['justfile', 'just'],
    ['go.mod', 'go-mod'],
    ['Cargo.toml', 'rust-config'],
    ['package.json', 'package-config'],
    ['yarn.lock', 'yarn-lock'],
    ['bun.lockb', 'bun-lock'],
    ['SECURITY.md', 'security'],
    ['CODEOWNERS', 'codeowners'],
    ['types.d.ts', 'typescript-def'],
    ['Button.stories.tsx', 'storybook'],
    ['tailwind.config.ts', 'tailwind'],
    ['next.config.mjs', 'next'],
    ['Button.test.ts', 'test-blue'],
    ['guide.mdx', 'markdownx'],
    ['App.tsx', 'react-typescript'],
    ['level.tscn', 'godot'],
    // Keys that existed all along and were unreachable, because the bare
    // extension was tried before the whole name and before the stem.
    ['tsconfig.json', 'typescript-config'],
    ['README.md', 'readme'],
    ['LICENSE', 'license'],
    ['vite.config.ts', 'vite'],
    ['.nvmrc', 'node'],
  ]
  for (const [file, want] of cases) {
    const got = resolveIcon(file, false, false, false)
    check(`${file} -> ${want}`, got.endsWith(`/${want}.svg`), got.split('/').pop())
  }

  // ── A name that is a TYPE must not outrank the extension ────────────
  //
  // Reported from the icon set's own folder, which is the perfect adversarial
  // case: it is 249 files called `<a-type-name>.svg`. The stem rule consulted
  // the WHOLE map, so `bash.svg` came out as bash, `c.svg` as C, `css.svg` as
  // CSS — every icon rendered as its own subject. Only names of FILES may beat
  // an extension, never names of types.
  for (const stem of [
    'bash', 'c', 'cpp', 'css', 'csv', 'astro', 'lua', 'zip', 'pdf', 'go',
    'java', 'json', 'toml', 'node', 'vue', 'svelte',
    // ...and the document names too, when the extension is a picture.
    'changelog', 'readme', 'license', 'authors', 'contributing', 'codeowners',
  ]) {
    const got = resolveIcon(`${stem}.svg`, false, false, false)
    check(`${stem}.svg is a picture`, got.endsWith('/svg.svg'), got.split('/').pop())
  }
  // The same names in a document extension still resolve to the document.
  for (const [file, want] of [
    ['README.md', 'readme'],
    ['CHANGELOG.md', 'changelog'],
    ['CONTRIBUTING.md', 'contributing'],
    ['AUTHORS.txt', 'authors'],
    ['LICENSE.md', 'license'],
  ] as [string, string][]) {
    const got = resolveIcon(file, false, false, false)
    check(`${file} -> ${want}`, got.endsWith(`/${want}.svg`), got.split('/').pop())
  }
  // And a config stem wins whatever it is written in — no picture is called
  // `next.config.svg`, so this one needs no extension guard.
  for (const file of ['vite.config.ts', 'vite.config.mjs', 'next.config.js', 'tailwind.config.cjs']) {
    const got = resolveIcon(file, false, false, false)
    check(`${file} keeps its config icon`, !got.endsWith('/typescript.svg') && !got.endsWith('/javascript.svg'), got.split('/').pop())
  }

  // And the standing check, so the next icon added to the set cannot quietly
  // become unreachable. These five are inert on purpose: nothing in a FILENAME
  // can honestly select them — `workflow` wants a path, `test-teal` and
  // `test-yellow` are colour variants with no signal to choose between, `css3` is
  // an alternative spelling of `css`, and `roblox-lock` has no filename.
  const INERT = new Set(['css3', 'event', 'roblox-lock', 'test-teal', 'test-yellow', 'workflow'])
  const mapped = new Set(allMappedIconNames())
  const unreachable = [...present.base!]
    .filter((n) => !n.startsWith('folder_') && !n.startsWith('_'))
    .filter((n) => !mapped.has(n))
    .sort()
  check(
    'every file icon in the set is reachable, bar the known-inert ones',
    unreachable.every((n) => INERT.has(n)),
    unreachable.filter((n) => !INERT.has(n)).join(', ') || 'none',
  )
  console.log(`      ${present.base!.size} icons, ${mapped.size} reachable, ${unreachable.length} inert`)
}

console.log(failures === 0 ? '\nALL ICON CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

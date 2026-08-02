/**
 * File-management helpers behind the tree's context menu: legal names,
 * duplicate numbering, gitignore lines. A wrong answer here renames the
 * wrong file or ignores the wrong tree.
 *
 *   npm run smoke:fileops
 */

import { sep } from 'node:path'
import {
  appendIgnoreLine,
  gitignoreLineFor,
  isPathInside,
  pasteTargetPath,
  uniqueDuplicatePath,
  validateEntryName,
} from '../src/main/ipc/file-ops.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Names ──────────────────────────────────────────────────────────────

check('an ordinary name passes', validateEntryName('notes.md').ok)
check('spaces are fine', validateEntryName('my notes.md').ok)
check('cyrillic is fine', validateEntryName('заметки.md').ok)
check('a nested path is allowed (VS Code style)', validateEntryName('src/utils/x.ts').ok)
check('empty is refused', !validateEntryName('   ').ok)
check('.. cannot escape', !validateEntryName('../evil.ts').ok)
check('nor can a dot segment', !validateEntryName('src/./x.ts').ok)
check('windows-forbidden characters are refused', !validateEntryName('a?b.ts').ok)
check('a trailing dot is refused (windows)', !validateEntryName('name.').ok)
check('an empty segment is refused', !validateEntryName('src//x.ts').ok)

// ─── Duplicate numbering ────────────────────────────────────────────────

const J = (...p: string[]): string => p.join(sep)
{
  const taken = new Set<string>()
  const exists = (c: string): boolean => taken.has(c)
  check(
    'first duplicate is "name copy.ext"',
    uniqueDuplicatePath(J('d', 'report.md'), exists) === J('d', 'report copy.md'),
    uniqueDuplicatePath(J('d', 'report.md'), exists),
  )
  taken.add(J('d', 'report copy.md'))
  check(
    'then "name copy 2.ext"',
    uniqueDuplicatePath(J('d', 'report.md'), exists) === J('d', 'report copy 2.md'),
  )
  taken.add(J('d', 'report copy 2.md'))
  check(
    'and the numbering keeps counting',
    uniqueDuplicatePath(J('d', 'report.md'), exists) === J('d', 'report copy 3.md'),
  )
  check(
    'a file with no extension still works',
    uniqueDuplicatePath(J('d', 'Makefile'), () => false) === J('d', 'Makefile copy'),
  )
}

// ─── Gitignore lines ────────────────────────────────────────────────────

check(
  'a file earns a rooted forward-slash line',
  gitignoreLineFor(J('C:', 'proj'), J('C:', 'proj', 'dist', 'out.js'), false) ===
    '/dist/out.js',
)
check(
  'a directory earns a trailing slash',
  gitignoreLineFor(J('C:', 'proj'), J('C:', 'proj', 'dist'), true) === '/dist/',
)
check(
  'a path outside the root earns nothing',
  gitignoreLineFor(J('C:', 'proj'), J('C:', 'other', 'x.js'), false) === null,
)

check('appending to an empty file is just the line', appendIgnoreLine('', '/dist/') === '/dist/\n')
check(
  'appending keeps existing content newline-clean',
  appendIgnoreLine('node_modules\n', '/dist/') === 'node_modules\n/dist/\n',
)
check(
  'a line already present is not doubled',
  appendIgnoreLine('node_modules\n/dist/\n', '/dist/') === null,
)

// ─── Paste ──────────────────────────────────────────────────────────────

check(
  'a paste keeps its own name when the slot is free',
  pasteTargetPath(J('C:', 'dst'), J('C:', 'src', 'a.ts'), () => false) ===
    J('C:', 'dst', 'a.ts'),
)
check(
  'and falls into copy-numbering when it is taken',
  pasteTargetPath(
    J('C:', 'dst'),
    J('C:', 'src', 'a.ts'),
    (c) => c === J('C:', 'dst', 'a.ts'),
  ) === J('C:', 'dst', 'a copy.ts'),
)

check('a folder contains itself', isPathInside(J('C:', 'a'), J('C:', 'a')))
check('and its descendants', isPathInside(J('C:', 'a'), J('C:', 'a', 'b', 'c')))
check('but not its siblings', !isPathInside(J('C:', 'a'), J('C:', 'ab')))
check('nor its parent', !isPathInside(J('C:', 'a', 'b'), J('C:', 'a')))

console.log(failures === 0 ? '\nALL FILE-OPS CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

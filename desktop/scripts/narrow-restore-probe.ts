/**
 * A restore puts back the turn's files and leaves everything else alone.
 *
 * End to end, on a real folder with a real shadow repo, because the two
 * halves are only worth anything together: the ledger decides WHICH files,
 * git supplies WHAT they were, and the failure this replaces —
 * `reset --hard`, which restored the whole tree — destroyed unsaved work
 * without a word.
 *
 * The scene is the one that matters: while a turn edits two files, the
 * person at the keyboard edits a third and also touches one of the
 * turn's. Afterwards the turn is rewound. Their work must survive both
 * times.
 *
 *   npm run smoke:narrowrestore
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(
      `FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    )
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'narrow-restore-data-'))
const { setDataDir } = await import('../src/main/data-dir.js')
setDataDir(dataDir)

const { snapshotWorkspace, indexWorkspace, restoreFiles } = await import(
  '../src/main/agent/checkpoints.js'
)
const { changedIn, foldDelta, withoutUserEdits, restorePlan, EMPTY_DELTA } =
  await import('../src/main/agent/file-ledger.js')

const work = mkdtempSync(join(tmpdir(), 'narrow-restore-work-'))
const write = (rel: string, text: string): void => {
  const full = join(work, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
}
const read = (rel: string): string | null =>
  existsSync(join(work, rel)) ? readFileSync(join(work, rel), 'utf8') : null

// A project that already has files, and a .gitignore, like a real one.
write('src/app.ts', 'original app\n')
write('src/util.ts', 'original util\n')
write('notes.md', 'my notes\n')
write('.gitignore', 'build/\n')
write('build/out.js', 'generated\n')

const SESSION = 'probe-session'
const baseline = await snapshotWorkspace(SESSION, work)
check('the workspace snapshots', !!baseline, baseline)

// ─── The turn runs, and the user types at the same time ─────────────────

let ledger = EMPTY_DELTA

{
  // Window 1: a tool edits app.ts.
  const before = await indexWorkspace(SESSION, work)
  write('src/app.ts', 'changed by the turn\n')
  const after = await indexWorkspace(SESSION, work)
  ledger = foldDelta(ledger, changedIn(before!, after!))

  // Between windows the USER edits notes.md. Nobody's tool touched it.
  write('notes.md', 'my notes, edited while it ran\n')

  // Window 2: a PYTHON script writes a file no tool reported, and also
  // rewrites util.ts.
  const before2 = await indexWorkspace(SESSION, work)
  write('src/generated.ts', 'made by a script\n')
  write('src/util.ts', 'changed by a script\n')
  const after2 = await indexWorkspace(SESSION, work)
  ledger = foldDelta(ledger, changedIn(before2!, after2!))
}

{
  check(
    'the ledger caught the file a tool never named',
    ledger.added.includes('src/generated.ts'),
    ledger,
  )
  check(
    'and both edited files',
    ledger.modified.includes('src/app.ts') &&
      ledger.modified.includes('src/util.ts'),
    ledger,
  )
  check(
    "the user's file is not in the turn's ledger — it changed between windows",
    !ledger.modified.includes('notes.md'),
    ledger,
  )
  check(
    'and an ignored build output never entered the picture at all',
    ![...ledger.added, ...ledger.modified].some((p) => p.startsWith('build/')),
    ledger,
  )
}

// ─── The rewind ─────────────────────────────────────────────────────────

{
  // The user has ALSO edited one of the turn's files by now. That one is
  // contested, and the tie goes to them.
  write('src/util.ts', 'and then I edited it myself\n')
  const { ledger: safe, skipped } = withoutUserEdits(ledger, ['src/util.ts'])
  check('the contested file is skipped by name', skipped.join() === 'src/util.ts', skipped)

  const r = await restoreFiles(SESSION, work, baseline!, restorePlan(safe))
  check('the restore reports success', r.ok, r)

  check(
    "the turn's edit is undone",
    read('src/app.ts') === 'original app\n',
    read('src/app.ts'),
  )
  check(
    'the file the turn invented is gone',
    read('src/generated.ts') === null,
  )
  check(
    "the user's own file was never touched",
    read('notes.md') === 'my notes, edited while it ran\n',
    read('notes.md'),
  )
  check(
    'and the contested file keeps THEIR version, not the checkpoint\'s',
    read('src/util.ts') === 'and then I edited it myself\n',
    read('src/util.ts'),
  )
  check(
    'the ignored build output is untouched',
    read('build/out.js') === 'generated\n',
  )
}

// ─── A restore for another folder refuses ───────────────────────────────

{
  const elsewhere = mkdtempSync(join(tmpdir(), 'narrow-restore-other-'))
  writeFileSync(join(elsewhere, 'theirs.txt'), 'not mine\n', 'utf8')
  const r = await restoreFiles(SESSION, elsewhere, baseline!, {
    write: ['src/app.ts'],
    delete: [],
  })
  check('restoring into another folder refuses', !r.ok, r)
  check(
    "…and that folder's files are untouched",
    readFileSync(join(elsewhere, 'theirs.txt'), 'utf8') === 'not mine\n',
  )
}

console.log(
  failures ? `\n${failures} FAILED` : '\nA RESTORE TOUCHES ONLY THE TURN\'S FILES',
)
process.exit(failures ? 1 : 0)

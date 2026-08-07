/**
 * Rewinding several turns, on a real folder.
 *
 * `reset --hard` is gone. A rewind now folds the ledgers of every turn
 * after the chosen checkpoint and puts back exactly those files, which is
 * a different thing in three ways that matter:
 *
 *   - a file NEITHER turn touched is never written, so somebody's
 *     unrelated work cannot be reverted by a rewind that had no business
 *     with it;
 *   - a file created two turns ago and edited since comes out as CREATED
 *     across the fold, so it is deleted rather than rewritten to a
 *     version that never existed;
 *   - a file edited by the user AFTER the last snapshot is theirs, and is
 *     left alone and named.
 *
 * And when the ledgers are missing — a chat from before they existed —
 * git's own diff between the two checkpoints stands in. Narrower than a
 * reset by a long way, just without knowing whose change each was.
 *
 *   npm run smoke:rewindledger
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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

const { setDataDir } = await import('../src/main/data-dir.js')
setDataDir(mkdtempSync(join(tmpdir(), 'rewind-ledger-data-')))

const { snapshotWorkspace, indexWorkspace, rewindWorkspace, saveLedger } =
  await import('../src/main/agent/checkpoints.js')
const { changedIn, EMPTY_DELTA, foldDelta } = await import(
  '../src/main/agent/file-ledger.js'
)

const work = mkdtempSync(join(tmpdir(), 'rewind-ledger-work-'))
const put = (rel: string, text: string): void => {
  mkdirSync(join(work, rel, '..'), { recursive: true })
  writeFileSync(join(work, rel), text, 'utf8')
}
const read = (rel: string): string | null =>
  existsSync(join(work, rel)) ? readFileSync(join(work, rel), 'utf8') : null

put('keep.ts', 'nobody touches this\n')
put('app.ts', 'v0\n')

const S = 'rewind-probe'
const base = await snapshotWorkspace(S, work)
check('a baseline checkpoint exists', !!base)

/** Run a turn: change files, record the window, snapshot, store the ledger. */
async function turn(change: () => void): Promise<string> {
  const before = await indexWorkspace(S, work)
  change()
  const after = await indexWorkspace(S, work)
  const delta = foldDelta(EMPTY_DELTA, changedIn(before!, after!))
  const sha = await snapshotWorkspace(S, work)
  saveLedger(S, sha!, delta)
  return sha!
}

// Turn 1 edits app.ts and creates one file. Turn 2 edits that new file.
await turn(() => {
  put('app.ts', 'v1\n')
  put('made.ts', 'first version\n')
})
await turn(() => {
  put('made.ts', 'second version\n')
})

// ─── Rewinding BOTH turns ───────────────────────────────────────────────

{
  const r = await rewindWorkspace(S, work, base!)
  check('the rewind succeeds', r.ok, r)
  check('the edited file is back to its baseline', read('app.ts') === 'v0\n', read('app.ts'))
  check(
    'the file created two turns ago and edited since is DELETED, not rewritten',
    read('made.ts') === null,
    read('made.ts'),
  )
  check(
    'a file neither turn touched is untouched',
    read('keep.ts') === 'nobody touches this\n',
  )
  check('and it reports what it did', (r.restored ?? 0) >= 1, r)
}

// ─── A file the user edited since the last snapshot ─────────────────────

{
  await snapshotWorkspace(S, work) // a clean starting point
  const mark = await snapshotWorkspace(S, work)
  await turn(() => put('app.ts', 'changed by the turn\n'))

  // The user edits it afterwards — this version exists nowhere else.
  put('app.ts', 'and then I typed this\n')

  const r = await rewindWorkspace(S, work, mark!)
  check('the rewind still succeeds', r.ok, r)
  check(
    "the user's newer edit is NOT overwritten",
    read('app.ts') === 'and then I typed this\n',
    read('app.ts'),
  )
  check(
    '…and the file is named as skipped rather than silently left',
    (r.skipped ?? []).includes('app.ts'),
    r.skipped,
  )
}

// ─── A turn that changed nothing ────────────────────────────────────────
//
// Most turns are conversation: no tools, no writes, and nothing for the
// window to catch. Such a turn still takes a snapshot, and if it does not
// also record its (empty) ledger it is indistinguishable from a turn taken
// before ledgers existed — so the rewind falls back to a git diff for the
// WHOLE range, and a git diff cannot tell whose change each was.
//
// Caught live: six turns of prose between a write and a rewind, and the
// file the user had made in the meantime was deleted.

{
  const mark = await snapshotWorkspace(S, work)
  await turn(() => put('written.ts', 'by the turn\n'))

  // The user makes a file of their own, between turns.
  put('theirs.ts', 'made by the user between turns\n')

  // …and then a turn that only talks. It changes nothing, and says so.
  const sha = await snapshotWorkspace(S, work)
  saveLedger(S, sha!, EMPTY_DELTA)

  const r = await rewindWorkspace(S, work, mark!)
  check('the rewind succeeds across a turn that did nothing', r.ok, r)
  check(
    "the talking turn does not drag the user's file into the rewind",
    read('theirs.ts') === 'made by the user between turns\n',
    read('theirs.ts'),
  )
  check(
    '…while the file the turn DID write is still undone',
    read('written.ts') === null,
    read('written.ts'),
  )
}

// ─── A chat from before ledgers existed ─────────────────────────────────

{
  const mark = await snapshotWorkspace(S, work)
  put('legacy.ts', 'made without a ledger\n')
  put('keep.ts', 'still nobody touches this\n')
  const after = await snapshotWorkspace(S, work)
  check('two more checkpoints exist', !!mark && !!after)
  // No saveLedger call at all — exactly what an older chat looks like.

  const r = await rewindWorkspace(S, work, mark!)
  check('a rewind without ledgers still works', r.ok, r)
  check(
    'git supplies the file list: the new file is gone',
    read('legacy.ts') === null,
  )
  check(
    'and the file it did change is back',
    read('keep.ts') === 'nobody touches this\n',
    read('keep.ts'),
  )
}

// ─── Somewhere else entirely ────────────────────────────────────────────

{
  const other = mkdtempSync(join(tmpdir(), 'rewind-ledger-other-'))
  writeFileSync(join(other, 'theirs.txt'), 'not mine\n', 'utf8')
  const r = await rewindWorkspace(S, other, base!)
  check('a rewind aimed at another folder refuses', !r.ok, r)
  check(
    "…and that folder is untouched",
    readFileSync(join(other, 'theirs.txt'), 'utf8') === 'not mine\n',
  )
  rmSync(other, { recursive: true, force: true })
}

console.log(
  failures ? `\n${failures} FAILED` : '\nA REWIND UNDOES THE TURNS AND NOTHING ELSE',
)
process.exit(failures ? 1 : 0)

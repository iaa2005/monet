/**
 * What a turn changed, and whose change it was.
 *
 * The rule this pins decides whether somebody's unsaved work survives a
 * rewind, so it is checked directly rather than through an agent. Three
 * things matter and each has a way of going quietly wrong:
 *
 *   - the CLASSIFICATION has to be of the whole turn, not of the last
 *     window: a file created and then edited again is still created, and
 *     a restore that "modifies" it instead of deleting it leaves a file
 *     behind that the turn invented;
 *   - a file created and then deleted inside the same turn is NOTHING,
 *     and a restore that tries to put it back resurrects a file the turn
 *     deliberately removed;
 *   - a file the USER also edited is contested, and the tie goes to the
 *     person at the keyboard, because their edit is unsaved work while
 *     the turn's is recoverable from the checkpoint.
 *
 *   npm run smoke:ledger
 */

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

const {
  changedIn,
  foldDelta,
  withoutUserEdits,
  restorePlan,
  pathsOf,
  isEmpty,
  EMPTY_DELTA,
} = await import('../src/main/agent/file-ledger.js')

const index = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries))

// ─── One window ─────────────────────────────────────────────────────────

{
  const before = index({ 'a.ts': 'h1', 'b.ts': 'h1' })
  const after = index({ 'a.ts': 'h2', 'c.ts': 'h1' })
  const d = changedIn(before, after)
  check('an edited file is modified', d.modified.join() === 'a.ts', d)
  check('a new file is added', d.added.join() === 'c.ts', d)
  check('a vanished file is removed', d.removed.join() === 'b.ts', d)
  check('an untouched file appears nowhere', !pathsOf(d).includes('untouched'))
}

{
  const same = index({ 'a.ts': 'h1' })
  check('nothing changed is nothing', isEmpty(changedIn(same, same)))
}

// ─── Several windows in one turn ────────────────────────────────────────

{
  // Created by a Write, then rewritten by a Python script.
  let ledger = EMPTY_DELTA
  ledger = foldDelta(ledger, changedIn(index({}), index({ 'new.ts': 'h1' })))
  ledger = foldDelta(
    ledger,
    changedIn(index({ 'new.ts': 'h1' }), index({ 'new.ts': 'h2' })),
  )
  check(
    'created then edited is still CREATED',
    ledger.added.join() === 'new.ts' && ledger.modified.length === 0,
    ledger,
  )
  check(
    '…so restoring DELETES it rather than writing a version that never existed',
    restorePlan(ledger).delete.join() === 'new.ts' &&
      restorePlan(ledger).write.length === 0,
    restorePlan(ledger),
  )
}

{
  // A script writes a temp file and cleans up after itself.
  let ledger = EMPTY_DELTA
  ledger = foldDelta(ledger, changedIn(index({}), index({ 'tmp.json': 'h1' })))
  ledger = foldDelta(ledger, changedIn(index({ 'tmp.json': 'h1' }), index({})))
  check(
    'created then deleted in the same turn is NOTHING',
    isEmpty(ledger),
    ledger,
  )
}

{
  // Deleted, then written again with different content.
  let ledger = EMPTY_DELTA
  ledger = foldDelta(ledger, changedIn(index({ 'x.ts': 'h1' }), index({})))
  ledger = foldDelta(ledger, changedIn(index({}), index({ 'x.ts': 'h2' })))
  check(
    'deleted then recreated is MODIFIED — it exists at both ends',
    ledger.modified.join() === 'x.ts' &&
      ledger.added.length === 0 &&
      ledger.removed.length === 0,
    ledger,
  )
}

{
  let ledger = EMPTY_DELTA
  const twice = changedIn(index({ 'a.ts': 'h1' }), index({ 'a.ts': 'h2' }))
  ledger = foldDelta(foldDelta(ledger, twice), twice)
  check('modified twice is modified once', ledger.modified.length === 1, ledger)
}

{
  // Modified early, deleted later.
  let ledger = EMPTY_DELTA
  ledger = foldDelta(
    ledger,
    changedIn(index({ 'a.ts': 'h1' }), index({ 'a.ts': 'h2' })),
  )
  ledger = foldDelta(ledger, changedIn(index({ 'a.ts': 'h2' }), index({})))
  check(
    'modified then deleted ends as removed, once',
    ledger.removed.join() === 'a.ts' && ledger.modified.length === 0,
    ledger,
  )
  check(
    '…and a restore WRITES it back rather than deleting it again',
    restorePlan(ledger).write.join() === 'a.ts',
    restorePlan(ledger),
  )
}

// ─── The user was typing at the same time ───────────────────────────────

{
  const ledger = foldDelta(
    EMPTY_DELTA,
    changedIn(
      index({ 'mine.ts': 'h1', 'theirs.ts': 'h1' }),
      index({ 'mine.ts': 'h2', 'theirs.ts': 'h2' }),
    ),
  )
  const r = withoutUserEdits(ledger, ['theirs.ts'])
  check(
    "a file the user also edited is left alone",
    r.ledger.modified.join() === 'mine.ts',
    r.ledger,
  )
  check('…and is NAMED, so the rewind can say what it skipped', r.skipped.join() === 'theirs.ts', r.skipped)
  check(
    '…while the turn\'s own file is still restored',
    restorePlan(r.ledger).write.join() === 'mine.ts',
  )
}

{
  const ledger = foldDelta(
    EMPTY_DELTA,
    changedIn(index({}), index({ 'created.ts': 'h1' })),
  )
  const r = withoutUserEdits(ledger, ['created.ts'])
  check(
    'a file the turn created but the user then edited is NOT deleted',
    restorePlan(r.ledger).delete.length === 0,
    r,
  )
}

{
  const ledger = foldDelta(
    EMPTY_DELTA,
    changedIn(index({ 'a.ts': 'h1' }), index({ 'a.ts': 'h2' })),
  )
  const r = withoutUserEdits(ledger, [])
  check('no concurrent edits changes nothing', r.ledger === ledger && r.skipped.length === 0)
  const all = withoutUserEdits(ledger, ['a.ts'])
  check('the user editing everything leaves nothing to restore', isEmpty(all.ledger))
}

// ─── The plan a rewind would carry out ──────────────────────────────────

{
  const ledger = {
    added: ['new.ts'],
    modified: ['edited.ts'],
    removed: ['gone.ts'],
  }
  const plan = restorePlan(ledger)
  check(
    'files to write back are the modified AND the deleted ones',
    plan.write.join() === 'edited.ts,gone.ts',
    plan,
  )
  check('files to delete are the ones the turn invented', plan.delete.join() === 'new.ts')
  check(
    'and no file is in both lists',
    !plan.write.some((p) => plan.delete.includes(p)),
    plan,
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nTHE LEDGER KNOWS WHOSE CHANGE IT WAS')
process.exit(failures ? 1 : 0)

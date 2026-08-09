/**
 * A model message keeps its identity across saves.
 *
 * The transcript table was keyed by position alone — (session_id, seq) —
 * and every save deleted the session's rows and re-inserted them
 * renumbered. A message therefore had no identity, so the display side
 * (which does have ids) could only be related to it by COUNTING user
 * turns; and because this side also gets truncated by compaction and by
 * undo, the chat had to reconstruct "what is still in context" by
 * replaying the arithmetic of every past operation. That is the machinery
 * this replaces.
 *
 * What has to hold: an id survives a rewrite, the context flag survives a
 * rewrite, and a table of the WRONG SHAPE does not take the store down with
 * it — that last one is the failure this file exists for.
 *
 *   npm run smoke:transcriptid
 */

import { mkdtempSync } from 'node:fs'
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
setDataDir(mkdtempSync(join(tmpdir(), 'transcript-probe-')))

const { replaceTranscript, loadTranscriptWithMeta } = await import(
  '../src/main/session/transcript.js'
)
const { getSessionDb } = await import('../src/main/session/store.js')

type Msg = { role: 'user' | 'assistant'; content: string }
const said = (role: Msg['role'], content: string): Msg => ({ role, content })

// ─── A TABLE OF THE WRONG SHAPE ─────────────────────────────────────────
//
// MUST BE FIRST: the store's schema work runs once, on the first call, so a
// probe that touches it earlier can never see this path — which is exactly how
// the bug below survived. Every case in this file used a fresh temp data dir,
// where the table is created complete.
//
// The real failure, found on a 15-session database: the msg_id index was
// declared in the same exec batch as CREATE TABLE IF NOT EXISTS, so on a table
// created before that column existed the batch died with "no such column:
// msg_id". The ready flag stayed false, every later call re-ran the same
// failing batch, and the catches turned it into silence: no durable transcript
// and no context events for ANY chat, and /compact doing nothing because there
// was nothing to compact.
//
// It was answered with an ALTER TABLE per column, a ladder that grows a rung
// every time the shape changes and only ever gets exercised on somebody else's
// database. The shape is CHECKED instead, and a table that does not match is
// dropped: those chats lose their model history, which is a cost only a
// pre-release app can pay, and the store comes up working either way.

{
  // The five columns an older build wrote, created before transcript.ts opens.
  getSessionDb().exec(`
    CREATE TABLE IF NOT EXISTS transcript (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, seq)
    );
  `)
  getSessionDb()
    .prepare(
      'INSERT INTO transcript (session_id, seq, role, content, hidden) VALUES (?, ?, ?, ?, 0)',
    )
    .run('stale', 0, 'user', JSON.stringify('from the old shape'))
  const before = (
    getSessionDb().prepare('PRAGMA table_info(transcript)').all() as {
      name: string
    }[]
  ).map((c) => c.name)
  check(
    'the stale table really is missing the columns',
    !before.includes('msg_id') && !before.includes('in_context'),
    before,
  )

  replaceTranscript('fresh', [said('user', 'kept')] as never, [false], {
    ids: ['m-1'],
    inContext: [true],
  })
  const back = loadTranscriptWithMeta('fresh')
  check(
    'A TRANSCRIPT STILL WRITES ON A DATABASE OF THE WRONG SHAPE',
    back.messages.length === 1 && back.ids[0] === 'm-1',
    { messages: back.messages.length, ids: back.ids },
  )
  const after = (
    getSessionDb().prepare('PRAGMA table_info(transcript)').all() as {
      name: string
    }[]
  ).map((c) => c.name)
  check(
    '…because the table was rebuilt instead of dying on its own index',
    after.includes('msg_id') && after.includes('in_context'),
    after,
  )
  check(
    '…and the rows of the old shape went with it, rather than half-loading',
    loadTranscriptWithMeta('stale').messages.length === 0,
    loadTranscriptWithMeta('stale').messages.length,
  )
}

// ─── Identity survives a save ───────────────────────────────────────────

{
  const msgs = [said('user', 'one'), said('assistant', 'two')]
  replaceTranscript('s1', msgs as never, [false, false], {
    ids: ['m-1', 'm-2'],
    inContext: [true, true],
  })
  const back = loadTranscriptWithMeta('s1')
  check('the ids come back', back.ids.join() === 'm-1,m-2', back.ids)
  check('and everything is in context by default', back.inContext.every(Boolean))
}

// ─── The flag survives a save ───────────────────────────────────────────

{
  const msgs = [said('user', 'one'), said('assistant', 'two')]
  replaceTranscript('s1', msgs as never, undefined, {
    ids: ['m-1', 'm-2'],
    inContext: [false, false],
  })
  const back = loadTranscriptWithMeta('s1')
  check(
    'a message taken out of context stays out across a save',
    back.inContext.every((v) => v === false),
    back.inContext,
  )
  check(
    '…and the message itself is still there, not deleted',
    back.messages.length === 2,
    back.messages.length,
  )
  check('…with its id intact', back.ids.join() === 'm-1,m-2', back.ids)
}

// ─── A row written without an id ────────────────────────────────────────
//
// Not a legacy shape — the table has the column; something wrote a row without
// filling it in. It must load, and it must count as IN context, because the
// absence of a flag is not the same as being taken out of one.

{
  const d = getSessionDb()
  d.prepare('DELETE FROM transcript WHERE session_id = ?').run('bare')
  d.prepare(
    'INSERT INTO transcript (session_id, seq, role, content, hidden) VALUES (?, ?, ?, ?, ?)',
  ).run('bare', 0, 'user', JSON.stringify('hello'), 0)

  const back = loadTranscriptWithMeta('bare')
  check('a row with no id still loads', back.messages.length === 1)
  check('…and says so rather than inventing one', back.ids[0] === null, back.ids)
  check(
    '…and counts as IN context, which is the safe reading',
    back.inContext[0] === true,
    back.inContext,
  )
}

// ─── Saving without meta does not silently drop anyone ──────────────────

{
  replaceTranscript('s2', [said('user', 'x')] as never)
  const back = loadTranscriptWithMeta('s2')
  check(
    'a save that says nothing about context leaves the message in it',
    back.inContext[0] === true,
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nTRANSCRIPT KEEPS ITS IDENTITY')
process.exit(failures ? 1 : 0)

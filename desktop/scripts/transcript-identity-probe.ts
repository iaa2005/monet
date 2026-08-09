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
 * rewrite, and a transcript written by an older build — every row with a
 * null id — still loads and still counts as in context. That last one is
 * the migration, and it is the one that would strand somebody's chats.
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

// ─── A DATABASE FROM AN OLDER BUILD ─────────────────────────────────────
//
// MUST BE FIRST: the store's schema work runs once, on the first call, so a
// probe that touches it earlier can never see this path — which is exactly how
// the bug below survived. Every case in this file used a fresh temp data dir,
// where the table is created complete.
//
// The real failure, found on a 15-session database: the msg_id index was
// declared in the same exec batch as CREATE TABLE IF NOT EXISTS, so on a table
// created before that column existed the batch died with "no such column:
// msg_id" — before the ALTER TABLE that adds it. The ready flag stayed false,
// every later call re-ran the same failing batch, and the catches turned it
// into silence: no durable transcript and no context events for ANY chat, and
// /compact doing nothing because there was nothing to compact.

{
  // The five columns the old build wrote, created before transcript.ts opens.
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
  const before = (
    getSessionDb().prepare('PRAGMA table_info(transcript)').all() as {
      name: string
    }[]
  ).map((c) => c.name)
  check(
    'the legacy table really is missing the columns',
    !before.includes('msg_id') && !before.includes('in_context'),
    before,
  )

  replaceTranscript('legacy', [said('user', 'kept')] as never, [false], {
    ids: ['m-legacy'],
    inContext: [true],
  })
  const back = loadTranscriptWithMeta('legacy')
  check(
    'A TRANSCRIPT STILL WRITES ON A DATABASE FROM AN OLDER BUILD',
    back.messages.length === 1 && back.ids[0] === 'm-legacy',
    { messages: back.messages.length, ids: back.ids },
  )
  const after = (
    getSessionDb().prepare('PRAGMA table_info(transcript)').all() as {
      name: string
    }[]
  ).map((c) => c.name)
  check(
    '…because the migration ran instead of dying on its own index',
    after.includes('msg_id') && after.includes('in_context'),
    after,
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

// ─── A transcript from an older build ───────────────────────────────────

{
  // Exactly what the previous schema wrote: no id, no flag.
  const d = getSessionDb()
  d.prepare('DELETE FROM transcript WHERE session_id = ?').run('old')
  d.prepare(
    'INSERT INTO transcript (session_id, seq, role, content, hidden) VALUES (?, ?, ?, ?, ?)',
  ).run('old', 0, 'user', JSON.stringify('hello'), 0)

  const back = loadTranscriptWithMeta('old')
  check('an old transcript still loads', back.messages.length === 1)
  check('its rows have no id yet', back.ids[0] === null, back.ids)
  check(
    '…and count as IN context, which is what they were',
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

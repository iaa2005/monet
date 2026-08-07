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

/**
 * A turn's ledger is kept where its content is.
 *
 * The list of files a turn changed is useless without the commit holding
 * what they were, and the commit is useless without the list. So they
 * live together, in the shadow store — not in the session database, where
 * one could be deleted, moved or restored without the other and a rewind
 * would confidently write the wrong thing.
 *
 * Also pinned: the writer set. It decides when the folder is indexed, and
 * the failure it guards against is silent — a tool that writes but is not
 * on the list means a file nobody notices, which means a rewind that
 * leaves it behind. So an UNKNOWN tool counts as a writer, because a
 * plugin or an MCP server can do anything, and guessing "read-only" is
 * the guess that loses work.
 *
 *   npm run smoke:ledgerstore
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
setDataDir(mkdtempSync(join(tmpdir(), 'ledger-store-probe-')))

const { saveLedger, loadLedger, shadowDir } = await import(
  '../src/main/agent/checkpoints.js'
)
const { existsSync } = await import('node:fs')

const SESSION = 'probe'
const A = { added: ['new.ts'], modified: ['a.ts'], removed: [] }
const B = { added: [], modified: ['b.ts'], removed: ['gone.ts'] }

// ─── Round trip ─────────────────────────────────────────────────────────

{
  check('nothing stored yet reads as nothing', loadLedger(SESSION, 'abc1234') === null)

  saveLedger(SESSION, 'abc1234', A)
  check(
    'a ledger comes back as it went in',
    JSON.stringify(loadLedger(SESSION, 'abc1234')) === JSON.stringify(A),
    loadLedger(SESSION, 'abc1234'),
  )
}

// ─── One store, many turns ──────────────────────────────────────────────

{
  saveLedger(SESSION, 'def5678', B)
  check(
    'a second turn does not overwrite the first',
    JSON.stringify(loadLedger(SESSION, 'abc1234')) === JSON.stringify(A),
    loadLedger(SESSION, 'abc1234'),
  )
  check(
    'and the second is there too',
    JSON.stringify(loadLedger(SESSION, 'def5678')) === JSON.stringify(B),
  )
  check(
    'a sha nobody saved is still nothing',
    loadLedger(SESSION, '0000000') === null,
  )
}

// ─── It lives with the commits, not apart from them ─────────────────────

{
  check(
    "the ledger file sits inside the chat's own store",
    existsSync(join(shadowDir(SESSION), 'ledgers.json')),
    shadowDir(SESSION),
  )
  check(
    "another chat's store cannot see it",
    loadLedger('a-different-chat', 'abc1234') === null,
  )
}

// ─── Which tools make the folder worth indexing ─────────────────────────

{
  const { WRITERS, anyWriters } = await import(
    '../src/main/agent/writers.js'
  )
  check('a file-writing tool counts', anyWriters([{ name: 'Write' }]))
  check('so does a shell', anyWriters([{ name: 'Bash' }]))
  check(
    'so does anything that runs code — this is how a script’s writes are caught',
    anyWriters([{ name: 'RunPython' }]),
  )
  check(
    'a batch of pure reads does not pay for an index',
    !anyWriters([{ name: 'Read' }, { name: 'Grep' }, { name: 'Glob' }]),
  )
  check(
    'one writer among readers is enough',
    anyWriters([{ name: 'Read' }, { name: 'Edit' }]),
  )
  check(
    'an UNKNOWN tool counts as a writer — a plugin can do anything',
    anyWriters([{ name: 'SomeMcpServerTool' }]),
  )
  check('and nothing at all is nothing', !anyWriters([]))
  check(
    'the writer list is not empty, which would index on every batch',
    WRITERS.size > 5,
    WRITERS.size,
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nTHE LEDGER LIVES WITH ITS COMMITS')
process.exit(failures ? 1 : 0)

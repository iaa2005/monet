/**
 * A chat's space comes from its database row, not from the caller.
 *
 * Read, Write, Edit and Glob mean the chat's sandbox in Home and the user's
 * disk in Code. Which set a session gets used to be decided by a `space`
 * parameter that travelled from the renderer, through IPC, into the toolset
 * builder — so the boundary between "isolated chat" and "the user's files"
 * hung off a value the UI supplied.
 *
 * It hangs off the session row now. This probe is the guard: it writes real
 * rows and then asks for the toolset while LYING about the space, which is
 * the shape any such mistake would take.
 *
 * Runs on the DB harness (build-agent-db-probe.mjs) because it needs SQLite —
 * smoke-probe.ts covers the swap itself, which needs no database.
 */

import { getSessionStore } from '../src/main/session/store.js'
import {
  getVendorToolsForSpace,
  toolForExecution,
} from '../src/main/agent/vendor-tools.js'
import { sessionSpace } from '../src/main/agent/session-space.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const tools = (space: string | undefined, sid?: string): { name: string; searchHint?: string }[] =>
  getVendorToolsForSpace(space, sid) as unknown as { name: string; searchHint?: string }[]
const readOf = (space: string | undefined, sid?: string) =>
  tools(space, sid).find(t => t.name === 'Read')
/** The tool of that name in the ADVERTISED set — what execution must match. */
const readLike = (name: string, space: string | undefined, sid?: string): unknown =>
  getVendorToolsForSpace(space, sid).find(t => t.name === name)
const isSandbox = (t: { searchHint?: string } | undefined): boolean =>
  /sandbox/i.test(t?.searchHint ?? '')

async function main(): Promise<void> {
  const store = getSessionStore()
  const home = store.create('probe home', 'home')
  const code = store.create('probe code', 'code')

  check('the row records the space it was created with', sessionSpace(home.id) === 'home')
  check('…and for a Code chat too', sessionSpace(code.id) === 'code')

  check('Home chat gets the sandbox Read', isSandbox(readOf('home', home.id)))
  check('Code chat gets the disk Read', !isSandbox(readOf('code', code.id)))

  // The whole point. A caller claiming the wrong space must not move a chat.
  check(
    'a Home chat told it is Code STAYS sandboxed',
    isSandbox(readOf('code', home.id)),
  )
  check(
    '…and still has no Bash',
    !tools('code', home.id).some(t => t.name === 'Bash'),
  )
  check(
    'a Code chat told it is Home stays on disk',
    !isSandbox(readOf('home', code.id)),
  )

  // No row to ask: the caller's value is all there is, and it is honoured —
  // this is the prompt-seeding path, which advertises a toolset to nobody.
  check(
    'with no session, the requested space is used',
    isSandbox(readOf('home')) && !isSandbox(readOf('code')),
  )
  check('an unknown session id falls back the same way', sessionSpace('nope', 'home') === 'home')

  // ── What actually RUNS ────────────────────────────────────────────
  //
  // Everything above is about the toolset the model is SHOWN. Execution
  // resolved the name against the full registry instead, and the sandbox
  // tools are not in it — they share their names with the disk ones — so a
  // Home chat was shown the sandbox Read and ran the disk one, rooted at the
  // user's workspace. The two answers have to be the same tool.
  const params = (t: unknown): string[] => {
    const shape = (t as { inputSchema?: { shape?: Record<string, unknown> } })
      ?.inputSchema?.shape
    return shape ? Object.keys(shape) : []
  }
  for (const name of ['Read', 'Write', 'Edit', 'Glob']) {
    check(
      `${name} RUNS as the same tool Home was shown`,
      toolForExecution(name, 'home', home.id) === readLike(name, 'home', home.id),
      `${params(toolForExecution(name, 'home', home.id)).join(',')}`,
    )
  }
  check(
    "the Home reader takes a sandbox name, not a host path — that mismatch is what gave the game away",
    params(toolForExecution('Read', 'home', home.id)).includes('name'),
    params(toolForExecution('Read', 'home', home.id)).join(','),
  )
  check(
    'the Code reader still takes a host path',
    params(toolForExecution('Read', 'code', code.id)).includes('file_path'),
    params(toolForExecution('Read', 'code', code.id)).join(','),
  )
  check(
    'and a Home chat told it is Code still RUNS the sandbox reader',
    params(toolForExecution('Read', 'code', home.id)).includes('name'),
    params(toolForExecution('Read', 'code', home.id)).join(','),
  )
  check(
    'a tool the space forbids does not resolve at all',
    toolForExecution('Bash', 'code', home.id) === undefined,
  )

  console.log(failures === 0 ? '\nSPACE IS THE SESSION’S, NOT THE CALLER’S' : `\n${failures} FAILURES`)
  // Explicit: the session store keeps a SQLite handle open, so the process
  // would sit there forever waiting on an event loop nobody is going to feed.
  process.exit(failures ? 1 : 0)
}

void main()

/**
 * Artifacts land when the turn ends, not while it is running.
 *
 * They used to appear the moment a tool produced one — so a strip grew an
 * item at a time underneath an answer that was still being written, and
 * every addition shifted the text the reader was in the middle of.
 *
 * What has to stay true: a running turn shows nothing, a finished one
 * shows everything it made, and EARLIER turns are unaffected either way —
 * their strips were settled at the user message that ended them and must
 * not vanish because a new turn is in progress.
 *
 *   npm run smoke:artifacttiming
 */

import type { ChatMessage } from '../src/renderer/types/chat'

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

const { stripIndexes } = await import(
  '../src/renderer/components/chat/artifact-strips.js'
)

/** A tool message whose output claims a produced file. */
const made = (name: string, id: string): ChatMessage =>
  ({
    id,
    role: 'tool',
    content: '',
    timestamp: '2026-08-07T12:00:00.000Z',
    toolCall: {
      id,
      name: 'RunPython',
      input: {},
      // The real marker shape, from lib/sessionArtifacts:
      //   [artifact] <mime> <name> :: <path>
      output: `[artifact] image/png ${name} :: /tmp/${name}\n`,
      status: 'done',
    },
  }) as unknown as ChatMessage

const said = (role: 'user' | 'assistant', id: string): ChatMessage =>
  ({ id, role, content: 'x', timestamp: '2026-08-07T12:00:00.000Z' }) as unknown as ChatMessage

// ─── One turn, in progress ──────────────────────────────────────────────

{
  const msgs = [said('user', 'u1'), made('chart.png', 't1')]
  check(
    'a running turn shows no strip',
    stripIndexes(msgs, true).size === 0,
    [...stripIndexes(msgs, true).keys()],
  )
  const done = stripIndexes(msgs, false)
  check('…and the finished turn shows one', done.size === 1)
  check(
    '…anchored to the turn\'s last message',
    done.has(msgs.length - 1),
    [...done.keys()],
  )
}

// ─── An earlier turn keeps its strip while a new one runs ───────────────

{
  const msgs = [
    said('user', 'u1'),
    made('first.png', 't1'),
    said('assistant', 'a1'),
    said('user', 'u2'),
    made('second.png', 't2'),
  ]
  const live = stripIndexes(msgs, true)
  check(
    'the finished turn keeps its strip while the next one runs',
    live.size === 1 && live.has(2),
    [...live.keys()],
  )
  check(
    '…and the running turn still shows nothing',
    !live.has(4),
    [...live.keys()],
  )
  const settled = stripIndexes(msgs, false)
  check('both appear once everything has stopped', settled.size === 2, [
    ...settled.keys(),
  ])
}

// ─── Turns that made nothing ────────────────────────────────────────────

{
  const msgs = [said('user', 'u1'), said('assistant', 'a1')]
  check('a turn with no files gets no strip', stripIndexes(msgs, false).size === 0)
}

console.log(failures ? `\n${failures} FAILED` : '\nARTIFACTS WAIT FOR THE TURN')
process.exit(failures ? 1 : 0)

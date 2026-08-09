/**
 * "Remove this prompt from the model's context" — which way round it goes.
 *
 * The chat holds one boolean (is this prompt OUT?) and the agent takes the
 * opposite one (should it be IN?), so the call site reads
 *
 *     const dropped = outOfContext.has(id)
 *     setTurnContext(sessionId, id, dropped)
 *
 * — a variable named "dropped" handed to a parameter named "inContext", which
 * is correct exactly because it is a TOGGLE, and looks inverted every single
 * time anybody reads it. This file settles it by doing it rather than reading
 * it: press once, the prompt leaves the request; press again, it comes back.
 *
 * Driven through the real path — rows in the transcript table, loaded by
 * ensureTranscriptLoaded, addressed by the id the chat's bubble carries.
 * There used to be a `seedConversation` back door that let a probe put
 * messages into a conversation directly; it is gone, because the renderer was
 * using it to rebuild whole chats from their bubbles.
 *
 *   npm run smoke:turntoggle
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
setDataDir(mkdtempSync(join(tmpdir(), 'turn-toggle-probe-')))

const { replaceTranscript } = await import('../src/main/session/transcript.js')
const {
  ensureTranscriptLoaded,
  messagesInContext,
  setTurnContext,
  turnContextState,
} = await import('../src/main/agent/index.js')

type Msg = { role: 'user' | 'assistant'; content: unknown }
const said = (role: Msg['role'], content: string): Msg => ({ role, content })

// Two complete turns, the second with a tool call — the shape that makes the
// unit "a whole turn" rather than "a message": an assistant `tool_use` whose
// `tool_result` is missing is a request every provider refuses outright.
const SID = 'toggle'
const messages: Msg[] = [
  said('user', 'first question'),
  said('assistant', 'first answer'),
  said('user', 'second question'),
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a file' }],
  },
  said('assistant', 'second answer'),
]
// `bubble-1` and `bubble-3` are what the CHAT calls those two prompts — the
// ids its user bubbles carry, threaded through chat:send as userMessageId.
replaceTranscript(SID, messages as never, undefined, {
  ids: ['bubble-1', 'm2', 'bubble-3', 'm4', 'm5', 'm6'],
  inContext: [true, true, true, true, true, true],
})
await ensureTranscriptLoaded(SID)

check(
  'both prompts are addressable by the ids the chat gave them',
  turnContextState(SID)
    .map((t) => t.id)
    .join() === 'bubble-1,bubble-3',
  turnContextState(SID),
)
check('and both start in context', messagesInContext(SID).length === 6)

// ─── WHICH WAY ROUND ────────────────────────────────────────────────────
//
// This is the call the button makes. `dropped` is what the chat knows: is
// this prompt currently OUT? It is false here, so the toggle asks for
// inContext=false — take it out.

{
  const dropped = turnContextState(SID).find((t) => t.id === 'bubble-1')!.inContext === false
  check('the chat believes this prompt is IN context', dropped === false)

  const r = setTurnContext(SID, 'bubble-1', dropped)
  check('the call reports what it changed', r.ok && r.changed === 2, r)
  check(
    'PRESSING IT ONCE TAKES THE PROMPT OUT — it does not put more in',
    messagesInContext(SID).length === 4,
    messagesInContext(SID).length,
  )
  check(
    '…and it is the FIRST turn that left, not another one',
    !messagesInContext(SID).some((m) => m.content === 'first question') &&
      messagesInContext(SID).some((m) => m.content === 'second question'),
    messagesInContext(SID).map((m) =>
      typeof m.content === 'string' ? m.content : '·',
    ),
  )
  check(
    '…and the chat now says so, so the button can flip its icon',
    turnContextState(SID).find((t) => t.id === 'bubble-1')!.inContext === false,
    turnContextState(SID),
  )
  check(
    'nothing was deleted to achieve it',
    turnContextState(SID).length === 2,
    turnContextState(SID),
  )
}

// Pressing it again, with the state the chat now holds.

{
  const dropped = turnContextState(SID).find((t) => t.id === 'bubble-1')!.inContext === false
  check('the chat believes this prompt is OUT of context', dropped === true)

  const r = setTurnContext(SID, 'bubble-1', dropped)
  check(
    'PRESSING IT AGAIN PUTS IT BACK',
    r.ok && messagesInContext(SID).length === 6,
    { changed: r.changed, sent: messagesInContext(SID).length },
  )
}

// ─── A TURN LEAVES WHOLE, OR THE REQUEST IS INVALID ─────────────────────

{
  setTurnContext(SID, 'bubble-3', false)
  const sent = messagesInContext(SID)
  check(
    'taking out a prompt takes its tool call AND the result with it',
    sent.length === 2 &&
      !JSON.stringify(sent).includes('call-1'),
    sent.length,
  )
  setTurnContext(SID, 'bubble-3', true)
}

// ─── Idempotence, in both directions ────────────────────────────────────

{
  setTurnContext(SID, 'bubble-1', false)
  const again = setTurnContext(SID, 'bubble-1', false)
  check(
    'taking out what is already out changes nothing',
    again.ok && again.changed === 0,
    again,
  )
  setTurnContext(SID, 'bubble-1', true)
  const back = setTurnContext(SID, 'bubble-1', true)
  check(
    'and putting back what is already in changes nothing either',
    back.ok && back.changed === 0,
    back,
  )
  check('the whole conversation is sent again', messagesInContext(SID).length === 6)
}

{
  check(
    'an id that points at nothing is refused, not thrown',
    setTurnContext(SID, 'no-such-bubble', false).ok === false,
  )
}

console.log(
  failures ? `\n${failures} FAILED` : '\nTHE BUTTON REMOVES, THEN RESTORES',
)
process.exit(failures ? 1 : 0)

/**
 * Taking a prompt out of the model's context, by the turn.
 *
 * This replaces a truncation. "Undo last prompt" used to do
 * `msgs.length = cut` — the messages were gone from the transcript, the
 * chat went on showing them, and which ones were missing had to be
 * reconstructed by replaying the arithmetic of every past operation.
 *
 * Now a message carries a flag, and the rule that decides WHICH messages
 * a prompt takes with it lives in agent/turn-context.ts. That rule is
 * what this pins, because getting it wrong breaks an API call rather than
 * a display: an assistant `tool_use` whose `tool_result` is missing is a
 * request the model's provider rejects outright.
 *
 *   npm run smoke:turncontext
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

const { turnRange, danglingToolIds } = await import(
  '../src/main/agent/turn-context.js'
)

type Msg = { role: string; content: unknown }

/** Two prompts; the first one used a tool, and its tool_result carries a
 * harness note beside it — the exact shape that used to open a false turn
 * boundary in the middle of the first turn. */
const msgs: Msg[] = [
  { role: 'user', content: 'first prompt' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu-1' },
      { type: 'text', text: '[Harness note, not from the user — keep going.]' },
    ],
  },
  { role: 'assistant', content: 'answered the first' },
  { role: 'user', content: 'second prompt' },
  { role: 'assistant', content: 'answered the second' },
]

/** The agent's own rule, restated: a visible prompt, not a tool_result
 * continuation — and a message carrying tool_result blocks is a continuation
 * NO MATTER what text rode in beside them, because harness notes and late
 * user notes ride exactly there. */
const isBoundary = (m: Msg): boolean =>
  m.role === 'user' &&
  (typeof m.content === 'string' ||
    !(m.content as { type: string }[]).some((b) => b.type === 'tool_result'))

// ─── What a prompt owns ─────────────────────────────────────────────────

{
  const first = turnRange(msgs, 0, isBoundary)
  check('the first prompt owns four messages', first?.end === 4, first)
  check(
    '…which is its reply, its tool call AND the tool result',
    first?.start === 0,
    first,
  )

  const second = turnRange(msgs, 4, isBoundary)
  check('the last prompt owns the rest', second?.end === 6, second)
}

// ─── It stops at the next prompt ────────────────────────────────────────

{
  const first = turnRange(msgs, 0, isBoundary)!
  check(
    'it does not swallow the prompt after it',
    first.end === 4 && isBoundary(msgs[first.end]),
    first,
  )
}

// ─── Not a prompt, not a turn ───────────────────────────────────────────

{
  check(
    'a tool_result is not the start of a turn',
    turnRange(msgs, 2, isBoundary) === null,
  )
  check(
    'an assistant message is not either',
    turnRange(msgs, 1, isBoundary) === null,
  )
  check('and neither is nothing', turnRange(msgs, -1, isBoundary) === null)
}

// ─── The invariant that breaks a request ────────────────────────────────

{
  check(
    'the whole transcript is balanced to begin with',
    danglingToolIds(msgs).uses.length === 0 &&
      danglingToolIds(msgs).results.length === 0,
  )

  // Remove the first turn the way setTurnContext does — by its range.
  const { start, end } = turnRange(msgs, 0, isBoundary)!
  const sent = msgs.filter((_, i) => i < start || i >= end)
  const dangling = danglingToolIds(sent)
  check(
    'removing a whole turn leaves nothing dangling',
    dangling.uses.length === 0 && dangling.results.length === 0,
    dangling,
  )
  check('…and what remains is the second turn', sent.length === 2, sent.length)

  // What a HALF-removed turn would do, which is the thing the range rule
  // exists to prevent.
  const halved = msgs.filter((_, i) => i !== 0 && i !== 2)
  const broken = danglingToolIds(halved)
  check(
    'dropping the prompt but keeping its tool call IS caught',
    broken.uses.length === 1,
    broken,
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nPROMPTS LEAVE CONTEXT BY THE TURN')
process.exit(failures ? 1 : 0)

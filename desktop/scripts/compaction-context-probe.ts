/**
 * Compaction and "remove this prompt" are two levers on one history.
 *
 * A live run (npm run live:matrix compact_undo) caught what happens when
 * they meet: the user took a prompt out of context, the window filled, the
 * summariser read the WHOLE array — removed turns included — and handed the
 * model a summary containing the very thing the user had removed. It came
 * back in the model's own words. The same run caught a second one: a summary
 * of a short history is LONGER than the history (measured: 438 tokens in,
 * 951 out), which leaves the chat over the threshold, so the next turn
 * compacts again — summarising the summary, every turn, forever.
 *
 * This is the arithmetic of both fixes, without a model:
 *
 *   - a message out of context is not read, not replaced, not moved;
 *   - a rewritten message keeps its identity, or its id and its "removed"
 *     flag are silently lost with the object;
 *   - a compaction that does not shrink what is SENT is not applied.
 *
 *   npm run smoke:compactctx
 */

import type { LLMAdapter, LLMMessage } from '../src/main/llm/adapter.js'

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

const { compactMessages, estimateTokens } = await import(
  '../src/main/agent/compaction.js'
)

/** An adapter that answers with a fixed summary and records what it was
 * asked to summarise. */
function fakeAdapter(summary: string): LLMAdapter & { seen: string } {
  const a = {
    providerId: 'probe',
    providerName: 'probe',
    seen: '',
    async stream(): Promise<void> {},
    async complete(req: { messages: LLMMessage[] }): Promise<LLMMessage> {
      a.seen = JSON.stringify(req.messages)
      return { role: 'assistant', content: summary }
    },
  } as unknown as LLMAdapter & { seen: string }
  return a
}

const say = (role: 'user' | 'assistant', text: string): LLMMessage => ({
  role,
  content: text,
})

const run = (
  messages: LLMMessage[],
  adapter: LLMAdapter,
  extra: Record<string, unknown> = {},
): Promise<LLMMessage[]> =>
  compactMessages({
    messages,
    adapter,
    model: 'probe',
    maxTokens: 4000,
    ...extra,
  })

// A summary long enough to be a real saving against the history below.
const LONG_SUMMARY = `The conversation covered several topics. ${'Detail. '.repeat(30)}`
const filler = (n: number): string => `Text about topic ${n}. ${'word '.repeat(200)}`

// ─── A removed prompt is not summarised back in ─────────────────────────

{
  const secret = say('user', 'Remember this word: SIGMA-9')
  const ack = say('assistant', 'ok')
  const rest = [
    say('user', filler(1)),
    say('assistant', filler(2)),
    say('user', filler(3)),
    say('assistant', filler(4)),
    say('user', 'and finally this'),
    say('assistant', 'done'),
  ]
  const messages = [secret, ack, ...rest]
  const removed = new Set<LLMMessage>([secret, ack])

  const adapter = fakeAdapter(LONG_SUMMARY)
  const out = await run(messages, adapter, {
    inContext: (m: LLMMessage) => !removed.has(m),
  })

  check(
    'the summariser was never shown the removed prompt',
    !adapter.seen.includes('SIGMA-9'),
    adapter.seen.slice(0, 120),
  )
  check(
    'the summary does not contain it either',
    !JSON.stringify(out).includes('SIGMA-9') ||
      out.includes(secret),
    'the word may only appear as the original message',
  )
  check(
    'the removed messages are still there, as the SAME objects',
    out.includes(secret) && out.includes(ack),
    { secret: out.indexOf(secret), ack: out.indexOf(ack) },
  )
  check(
    '…and still first, where the user can see them',
    out.indexOf(secret) === 0 && out.indexOf(ack) === 1,
    out.map((m) => (m === secret ? 'secret' : m === ack ? 'ack' : '·')),
  )
  check(
    'the history did shrink',
    estimateTokens(out) < estimateTokens(messages),
    { after: estimateTokens(out), before: estimateTokens(messages) },
  )
  check(
    'and the last exchange survived verbatim',
    out.some((m) => m.content === 'done'),
    out.map((m) => String(m.content).slice(0, 20)),
  )
}

// ─── A compaction that does not shrink anything is not applied ──────────

{
  const messages = [
    say('user', 'one'),
    say('assistant', 'two'),
    say('user', 'three'),
    say('assistant', 'four'),
    say('user', 'five'),
    say('assistant', 'six'),
  ]
  const before = messages.map((m) => m.content)
  // The floor a real compact prompt has: a structured account of six words.
  const out = await run(messages, fakeAdapter(LONG_SUMMARY.repeat(4)))
  check(
    'a summary bigger than the conversation is refused',
    out === messages,
    { returned: out.length, same: out === messages },
  )
  check(
    '…and the conversation is untouched',
    messages.map((m) => m.content).join('|') === before.join('|'),
  )
}

// ─── Identity travels with a rewritten message ──────────────────────────

{
  // A big replayable tool result: the lossless pass rewrites its message.
  const toolUse: LLMMessage = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file: 'a.ts' } },
    ],
  }
  const toolResult: LLMMessage = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'x'.repeat(5_000),
      },
    ],
  }
  // Long enough that the tool result falls outside the protected tail —
  // microCompact leaves the last few messages alone on purpose.
  // (see also THE TRIGGER, at the end of this file)
  const messages = [
    say('user', 'read it'),
    toolUse,
    toolResult,
    say('assistant', 'read'),
    say('user', filler(9)),
    say('assistant', filler(10)),
    say('user', filler(11)),
    say('assistant', filler(12)),
    say('user', 'last'),
    say('assistant', 'done'),
  ]

  const carried: [LLMMessage, LLMMessage][] = []
  const out = await run(messages, fakeAdapter(LONG_SUMMARY), {
    threshold: 100_000, // big enough that the lossless pass is the whole job
    carry: (from: LLMMessage, to: LLMMessage) => carried.push([from, to]),
  })
  check(
    'the lossless pass rewrote the big tool result',
    carried.length === 1 && carried[0][0] === toolResult,
    carried.length,
  )
  check(
    '…and handed over the original so its id can follow it',
    carried[0]?.[1] !== undefined && out.includes(carried[0][1]),
  )
  check(
    'nothing was summarised — the lossless pass was enough',
    out.length === messages.length,
    { after: out.length, before: messages.length },
  )
}

// ─── Too little to compact ──────────────────────────────────────────────

{
  const messages = [say('user', 'a'), say('assistant', 'b'), say('user', 'c')]
  const out = await run(messages, fakeAdapter(LONG_SUMMARY))
  check('three messages are left alone', out === messages)
}

{
  // Six messages, but four of them removed: what is SENT is too short.
  const live = [say('user', 'a'), say('assistant', 'b')]
  const dead = [
    say('user', 'x'),
    say('assistant', 'y'),
    say('user', 'z'),
    say('assistant', 'w'),
  ]
  const messages = [...dead, ...live]
  const out = await run(messages, fakeAdapter(LONG_SUMMARY), {
    inContext: (m: LLMMessage) => live.includes(m),
  })
  check(
    'a chat that is long only because of removed turns is not compacted',
    out === messages,
  )
}

// ─── THE TRIGGER: room left, not a fraction filled ──────────────────────
//
// This was `inputBudget * 0.7`, which scales the waste with the window: on a
// 200k input budget it compacted at 140k and left 60,000 tokens paid for and
// never used. An absolute buffer is what the upstream CLI keeps
// (AUTOCOMPACT_BUFFER_TOKENS = 13_000), and 13k is what one more turn needs —
// a large tool result plus a reply. It does not grow because the window did.

{
  const { compactionThreshold, warningThreshold, AUTO_BUFFER_TOKENS, MANUAL_BUFFER_TOKENS } =
    await import('../src/main/agent/compaction.js')

  check(
    'a 200k input budget triggers at 187k, not 140k',
    compactionThreshold({ inputLimit: 200_000 }) === 200_000 - AUTO_BUFFER_TOKENS,
    compactionThreshold({ inputLimit: 200_000 }),
  )
  check(
    'THE BUFFER DOES NOT GROW WITH THE WINDOW',
    1_000_000 - compactionThreshold({ inputLimit: 1_000_000 }) === AUTO_BUFFER_TOKENS &&
      64_000 - compactionThreshold({ inputLimit: 64_000 }) === AUTO_BUFFER_TOKENS,
    [compactionThreshold({ inputLimit: 1_000_000 }), compactionThreshold({ inputLimit: 64_000 })],
  )
  check(
    'asked for by hand, it reclaims more',
    compactionThreshold({ inputLimit: 200_000 }, 'manual') === 200_000 - MANUAL_BUFFER_TOKENS &&
      MANUAL_BUFFER_TOKENS < AUTO_BUFFER_TOKENS,
  )
  check(
    'a context limit reserves output space first',
    compactionThreshold({ contextLimit: 100_000, outputReserve: 20_000 }) ===
      80_000 - AUTO_BUFFER_TOKENS,
    compactionThreshold({ contextLimit: 100_000, outputReserve: 20_000 }),
  )
  check(
    'a window smaller than the buffer still gives a usable number',
    compactionThreshold({ inputLimit: 8_000 }) === 4_000,
    compactionThreshold({ inputLimit: 8_000 }),
  )
  check(
    'the warning comes before the trigger, never after',
    warningThreshold({ inputLimit: 200_000 }) <
      compactionThreshold({ inputLimit: 200_000 }) &&
      warningThreshold({ inputLimit: 200_000 }) > 0,
    warningThreshold({ inputLimit: 200_000 }),
  )
}

console.log(
  failures
    ? `\n${failures} FAILED`
    : '\nCOMPACTION LEAVES REMOVED PROMPTS REMOVED',
)
process.exit(failures ? 1 : 0)

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

interface Result {
  messages: LLMMessage[]
  folded: LLMMessage[]
  header: LLMMessage | null
}

const run = (
  messages: LLMMessage[],
  adapter: LLMAdapter,
  extra: Record<string, unknown> = {},
): Promise<Result> =>
  compactMessages({
    messages,
    adapter,
    model: 'probe',
    maxTokens: 4000,
    ...extra,
  }) as Promise<Result>

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
    !JSON.stringify(out.header).includes('SIGMA-9'),
    'the word may only appear as the original message',
  )
  check(
    'the removed messages are still there, as the SAME objects',
    out.messages.includes(secret) && out.messages.includes(ack),
    { secret: out.messages.indexOf(secret), ack: out.messages.indexOf(ack) },
  )
  check(
    '…and still first, where the user can see them',
    out.messages.indexOf(secret) === 0 && out.messages.indexOf(ack) === 1,
    out.messages.map((m) => (m === secret ? 'secret' : m === ack ? 'ack' : '·')),
  )
  check(
    'and the last exchange survived verbatim',
    out.messages.some((m) => m.content === 'done'),
    out.messages.map((m) => String(m.content).slice(0, 20)),
  )

  // NOTHING IS DELETED — that is what an undo is made of.
  //
  // The summary replaces turns by standing in FRONT of them, not by removing
  // them: they stay in the array and the caller takes them out of context.
  // Deleting them meant a compaction could only be undone from a stored copy
  // of the whole conversation (over a megabyte, kept for ever), the chat could
  // no longer mark those prompts as unreadable, and the prompt COUNT moved —
  // which sent every later Rewind down the lossy path.
  check(
    'every message that went in comes back out',
    messages.every((m) => out.messages.includes(m)),
    { in: messages.length, out: out.messages.length },
  )
  check(
    'the summary is a message, and it is new',
    !!out.header && out.messages.includes(out.header),
  )
  check(
    'what it stands for is named, so it can be put back',
    out.folded.length > 0 && out.folded.every((m) => messages.includes(m)),
    out.folded.length,
  )
  check(
    'the removed prompt is NOT among what it stands for',
    !out.folded.includes(secret) && !out.folded.includes(ack),
  )

  // What the model would now be SENT: the summary plus what was not folded.
  const sent = out.messages.filter(
    (m) => !removed.has(m) && !out.folded.includes(m),
  )
  check(
    'THE CONTEXT DID SHRINK',
    estimateTokens(sent) < estimateTokens(messages.filter((m) => !removed.has(m))),
    {
      after: estimateTokens(sent),
      before: estimateTokens(messages.filter((m) => !removed.has(m))),
    },
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
    out.messages === messages && out.header === null && out.folded.length === 0,
    { returned: out.messages.length, same: out.messages === messages },
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
    carried[0]?.[1] !== undefined && out.messages.includes(carried[0][1]),
  )
  check(
    'nothing was summarised — the lossless pass was enough',
    out.header === null && out.messages.length === messages.length,
    { after: out.messages.length, before: messages.length },
  )
}

// ─── Too little to compact ──────────────────────────────────────────────

{
  const messages = [say('user', 'a'), say('assistant', 'b'), say('user', 'c')]
  const out = await run(messages, fakeAdapter(LONG_SUMMARY))
  check('three messages are left alone', out.messages === messages)
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
    out.messages === messages,
  )
}

// ─── A SCREENSHOT IS NOT FREE ───────────────────────────────────────────
//
// A tool_result whose content is a LIST of blocks — `[text, image]`, which is
// what Computer Use and the browser tools return — counted as ZERO here while
// micro-compaction counted it in full. A run driving a browser piles up
// megabytes of base64 in exactly that shape, so the estimate said the context
// was empty: no compaction, a meter reading near nothing, and eventually a
// request refused on length with nothing anywhere having warned about it.
//
// The other direction is just as wrong: an image is billed by its dimensions,
// so counting its base64 would call one screenshot a quarter of a million
// tokens. It is a flat estimate, like a top-level image block.

{
  const shot = (bytes: number): LLMMessage => ({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call-shot',
        content: [
          { type: 'text', text: 'took a screenshot' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) },
          },
        ],
      },
    ],
  })

  check(
    'a screenshot in a tool result is not worth zero',
    estimateTokens([shot(1_000_000)]) > 100,
    estimateTokens([shot(1_000_000)]),
  )
  check(
    '…and not worth its base64 either',
    estimateTokens([shot(1_000_000)]) < 2_000,
    estimateTokens([shot(1_000_000)]),
  )
  check(
    'its size on the wire does not change the estimate',
    estimateTokens([shot(1_000)]) === estimateTokens([shot(1_000_000)]),
    [estimateTokens([shot(1_000)]), estimateTokens([shot(1_000_000)])],
  )
  check(
    'a plain string tool result still counts its own length',
    estimateTokens([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c', content: 'x'.repeat(4_000) }],
      },
    ]) === 1_000,
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

// ─── THE BREAKER: a refusal that repeats is not retried for ever ────────
//
// Summarising is a model call and it can fail. The lossless pass is kept either
// way, so nothing is lost by giving up on the summary — while retrying it every
// turn costs real money for a refusal that is not going to change. Upstream
// measured that: 1,279 sessions with 50+ consecutive failures, ~250K wasted API
// calls a day.

{
  const { compactMessages, MAX_SUMMARY_FAILURES } = await import(
    '../src/main/agent/compaction.js'
  )
  const long: LLMMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'A'.repeat(40_000) },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'B'.repeat(40_000) },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'C'.repeat(40_000) },
  ]
  let calls = 0
  const failing = {
    providerId: 'probe',
    providerName: 'probe',
    async stream(): Promise<void> {},
    async complete(): Promise<LLMMessage> {
      calls++
      throw new Error('overloaded')
    },
  } as unknown as LLMAdapter

  const base = {
    messages: long,
    adapter: failing,
    model: 'm',
    maxTokens: 8_000,
    threshold: 100,
  }
  let seen: unknown = null
  const out = await compactMessages({
    ...base,
    onSummaryError: (err) => {
      seen = err
    },
  })
  check(
    'a failed summary still returns a usable conversation',
    Array.isArray(out.messages),
  )
  check('and the caller is told, so it can count', seen instanceof Error, String(seen))
  check('the attempt was actually made', calls === 1, calls)

  calls = 0
  await compactMessages({ ...base, allowSummary: false })
  check('THE BREAKER SPENDS NO MODEL CALL AT ALL', calls === 0, calls)
  check('three strikes, not one', MAX_SUMMARY_FAILURES === 3, MAX_SUMMARY_FAILURES)
}

// ─── FREE CLEARING: the cache window ────────────────────────────────────
//
// Clearing a tool result rewrites the prefix the server caches, so inside the
// cache's lifetime it costs the whole conversation at full price on the next
// turn. That is why this only ever ran at the threshold. After an hour the cache
// has expired by itself, there is nothing left to break, and the same clearing
// is free — which is the moment to do it, long before the lossy summarising pass
// becomes necessary.

{
  const { coldCache, CACHE_TTL_MINUTES } = await import(
    '../src/main/agent/microcompact.js'
  )
  const now = 1_700_000_000_000
  const minutes = (n: number): number => now - n * 60_000

  check('a chat the model has never answered in: nothing to clear', !coldCache(null, now))
  check('half an hour ago: the cache is live, clearing would cost', !coldCache(minutes(30), now))
  check('an hour and a minute ago: FREE', coldCache(minutes(61), now))
  check(
    'exactly the TTL is not past it',
    !coldCache(minutes(CACHE_TTL_MINUTES), now),
    CACHE_TTL_MINUTES,
  )
  check('yesterday: free', coldCache(minutes(60 * 20), now))
  check(
    'the window is the cache TTL, not a guess',
    CACHE_TTL_MINUTES === 60,
    CACHE_TTL_MINUTES,
  )
  check(
    'a shorter TTL can be asked for',
    coldCache(minutes(10), now, 5) && !coldCache(minutes(4), now, 5),
  )
}

console.log(
  failures
    ? `\n${failures} FAILED`
    : '\nCOMPACTION LEAVES REMOVED PROMPTS REMOVED',
)
process.exit(failures ? 1 : 0)

/**
 * Context compaction for the desktop agent loop.
 *
 * Long chats / long agentic runs accumulate tokens until they'd overflow the
 * model's context window. The upstream CLI solves this by summarizing the earlier
 * conversation and replacing it with a compact summary. The vendor query
 * engine (which we don't use) drives this via services/compact; here we do the
 * same thing against OUR message[] format and LLM adapter, reusing the vendor
 * compaction prompt + summary formatter so the behavior matches the upstream CLI.
 */

import { getCompactPrompt, formatCompactSummary } from '../engine/compact/prompt.js'
import type { LLMAdapter, LLMMessage } from '../llm/adapter.js'
import type { LLMContentBlock } from '../llm/adapter.js'
import { microCompact } from './microcompact.js'

// Fallback only for providers that expose neither an input nor a context limit.
// A configured MONET_COMPACT_TOKENS value remains an explicit override.
const configuredThreshold = Number(process.env.MONET_COMPACT_TOKENS)
const EXPLICIT_THRESHOLD =
  Number.isFinite(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold
    : undefined
const DEFAULT_THRESHOLD = EXPLICIT_THRESHOLD ?? 200_000

const DEFAULT_OUTPUT_RESERVE = 16_000

export interface CompactionBudget {
  /** Maximum prompt/input tokens, when the provider exposes one. */
  inputLimit?: number
  /** Total model context window, used when inputLimit is absent. */
  contextLimit?: number
  /** Output tokens to reserve when deriving an input budget from contextLimit. */
  outputReserve?: number
}

// Keep the summarization request itself from blowing the output budget.
//
// Upstream uses 20_000 (MAX_OUTPUT_TOKENS_FOR_SUMMARY). Ours stays at 8k, and
// deliberately: a summary of a 187k-token conversation in 8k is 4% of it, which
// is what a summary is for, and the guard below already rejects one that came out
// bigger than the exchanges it replaces. Copying a number because it is theirs is
// how the 0.7 threshold survived as long as it did.
const SUMMARY_MAX_TOKENS = 8_000

/**
 * Consecutive failed summarisations before the attempt is abandoned.
 *
 * The lossless pass keeps running — it costs nothing and cannot fail. What stops
 * is paying a model call to be refused again. Without a limit the retry is
 * per-turn and unbounded, which upstream measured the cost of
 * (services/compact/autoCompact.ts):
 *
 *     // BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
 *     // in a single session, wasting ~250K API calls/day globally.
 *
 * The state lives with the caller, next to the rest of the per-session state, so
 * this module stays pure: `allowSummary` in, `onSummaryError` out.
 */
export const MAX_SUMMARY_FAILURES = 3

/**
 * What a picture costs, whatever it weighs.
 *
 * An image is billed by its dimensions, not by the length of its base64, and
 * the two are nowhere near each other: a 1 MB screenshot is about 1,500 tokens
 * and 1,400,000 characters. Counting the characters would say a single
 * screenshot fills a 200k window seven times over.
 */
const IMAGE_CHARS = 2_000

/** Chars one block contributes to the estimate below. */
function blockChars(b: LLMContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length
    case 'tool_use':
      return JSON.stringify(b.input).length
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
      return IMAGE_CHARS
    case 'tool_result':
      // A LIST here is the shape a screenshot takes — `[text, image]`, from
      // Computer Use and the browser tools — and it used to count as ZERO.
      // A run driving a browser piles up megabytes of these, and the estimate
      // said the context was empty: no compaction, a meter reading near
      // nothing, and eventually a request refused on length with nothing
      // anywhere having warned about it.
      if (typeof b.content === 'string') return b.content.length
      return b.content.reduce(
        (n, inner) => n + (inner.type === 'text' ? inner.text.length : IMAGE_CHARS),
        0,
      )
    default:
      return 0
  }
}

/** Rough token estimate (chars/4) across our message content shapes. */
export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    else for (const b of m.content) chars += blockChars(b)
  }
  return Math.ceil(chars / 4)
}

export function shouldCompact(
  messages: LLMMessage[],
  threshold = DEFAULT_THRESHOLD,
): boolean {
  // Need enough history for a summary to be worthwhile.
  return messages.length >= 4 && estimateTokens(messages) > threshold
}

/**
 * How much room to leave, rather than what fraction to fill.
 *
 * This was `Math.floor(inputBudget * 0.7)`, and a percentage is the wrong shape:
 * it scales the waste with the window. On a 200k input budget it compacted at
 * 140k and left 60,000 tokens permanently unused — a third of what was paid for.
 * The upstream CLI keeps an absolute buffer instead
 * (services/compact/autoCompact.ts):
 *
 *     AUTOCOMPACT_BUFFER_TOKENS      = 13_000
 *     MANUAL_COMPACT_BUFFER_TOKENS   =  3_000
 *     WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
 *
 * 13k is what one more turn needs: a large tool result plus a reply. It does not
 * get bigger because the window did.
 *
 * Manual compaction gets a smaller buffer because it was asked for — the point is
 * to reclaim room now, not to leave headroom for a turn that may not come.
 */
export const AUTO_BUFFER_TOKENS = 13_000
export const MANUAL_BUFFER_TOKENS = 3_000
export const WARNING_BUFFER_TOKENS = 20_000

export function compactionThreshold(
  budget?: number | CompactionBudget,
  kind: 'auto' | 'manual' = 'auto',
): number {
  if (EXPLICIT_THRESHOLD != null) return EXPLICIT_THRESHOLD
  const buffer = kind === 'manual' ? MANUAL_BUFFER_TOKENS : AUTO_BUFFER_TOKENS
  const input = inputBudgetOf(budget)
  if (input == null) return DEFAULT_THRESHOLD
  // A window smaller than the buffer is not a reason to return a negative
  // threshold — halve it and let the model deal with a tight turn.
  return input > buffer ? input - buffer : Math.floor(input / 2)
}

/** Where the meter should start warning: one buffer earlier than the trigger. */
export function warningThreshold(budget?: number | CompactionBudget): number {
  const t = compactionThreshold(budget, 'auto')
  return Math.max(1, t - WARNING_BUFFER_TOKENS)
}

/** The provider's usable input budget, or null when it exposes neither limit. */
function inputBudgetOf(budget?: number | CompactionBudget): number | null {
  if (typeof budget === 'number') return validLimit(budget) ? budget : null
  if (!budget) return null
  if (validLimit(budget.inputLimit)) return budget.inputLimit
  if (validLimit(budget.contextLimit)) {
    const reserve = validLimit(budget.outputReserve)
      ? Math.min(budget.outputReserve, budget.contextLimit)
      : Math.min(DEFAULT_OUTPUT_RESERVE, budget.contextLimit)
    return Math.max(1, budget.contextLimit - reserve)
  }
  return null
}

function validLimit(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0
}

function extractText(msg: LLMMessage): string {
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('')
}

/**
 * What a compaction did.
 *
 * `folded` is the part the summary now stands for — and it is RETURNED rather
 * than removed. Deleting it was the old shape, and three things fell out of
 * that: the chat could no longer say which of its prompts the model had
 * stopped reading (the messages were gone, so there was nothing to mark), the
 * user-turn count moved, which made every later Rewind fall back to a
 * text-only rebuild, and undoing a compaction needed a full copy of the
 * conversation stored in the event log — measured at over a megabyte apiece,
 * kept for ever.
 *
 * Taking them out of context instead costs nothing extra: that flag already
 * exists, it is already what "the model cannot read this" means everywhere
 * else in this app, and it is already reversible. See setInContext().
 *
 * The price is that the transcript stops SHRINKING when a chat is compacted —
 * it grows monotonically, like the chat on screen, and is written out whole on
 * every turn. That is the same order of magnitude as the display table, which
 * has always been kept in full; what it buys is that the two now describe the
 * same conversation, and that is what every operation over both of them was
 * getting wrong.
 */
export interface CompactionResult {
  /** The history to continue from. The SAME array reference that came in when
   * nothing could be done, so the caller can tell "nothing to give" from
   * "compacted". */
  messages: LLMMessage[]
  /** Messages the summary replaces. Still present, in place — the caller
   * takes them out of context. */
  folded: LLMMessage[]
  /** The summary message, when one was produced. */
  header: LLMMessage | null
}

/**
 * Summarize the conversation.
 *
 * On any failure the original messages are returned unchanged (compaction is
 * best-effort — never break the turn).
 */
export async function compactMessages(opts: {
  messages: LLMMessage[]
  adapter: LLMAdapter
  model: string
  maxTokens: number
  signal?: AbortSignal
  /** Extra instruction appended to the summary request (caveman mode). */
  terseHint?: string
  /** Token budget to aim for; enables the lossless pass. */
  threshold?: number
  /** User turns to keep verbatim after the summary. 0 = old behaviour. */
  keepRecentTurns?: number
  /**
   * Whether to attempt the summary at all. False after MAX_SUMMARY_FAILURES
   * consecutive failures for this chat: the lossless pass still runs, because it
   * costs nothing and cannot fail, but a model call that has been refused three
   * times running is not going to be answered on the fourth.
   */
  allowSummary?: boolean
  /** Called when the summary attempt threw, so the caller can count. */
  onSummaryError?: (err: unknown) => void
  /**
   * Whether the model is still being sent this message.
   *
   * A prompt the user took out of context must not be summarised — a summary
   * of it is that content back again, which is the opposite of what they
   * asked for — and must not be dropped either, or removing a prompt would
   * stop being reversible. Such messages are stepped over: not read, not
   * replaced, left exactly where they are.
   */
  inContext?: (m: LLMMessage) => boolean
  /** Carry a message's identity (its id, its flags) onto the copy the
   * lossless pass makes of it. Without this a rewritten message is a new
   * object, and the chat can no longer point at the turn it belongs to. */
  carry?: (from: LLMMessage, to: LLMMessage) => void
}): Promise<CompactionResult> {
  const {
    messages,
    adapter,
    model,
    maxTokens,
    signal,
    terseHint,
    threshold,
    keepRecentTurns = 2,
    allowSummary = true,
    onSummaryError,
    carry,
  } = opts
  const inContext = opts.inContext ?? ((): boolean => true)

  /** Nothing happened: the same array back, so the caller can tell. */
  const unchanged = (): CompactionResult => ({
    messages,
    folded: [],
    header: null,
  })

  // Where each still-sent message sits in the full list, so the compacted
  // result can be woven back among the ones that were left out.
  const liveAt: number[] = []
  for (let i = 0; i < messages.length; i++)
    if (inContext(messages[i])) liveAt.push(i)
  const live = liveAt.map(i => messages[i])
  if (live.length < 4) return unchanged()

  // Pass 1 — lossless. Clearing replayable tool output is often enough on its
  // own, and it costs no model call and loses nothing that was SAID.
  const micro = microCompact(live)
  if (micro.cleared > 0 && carry)
    for (let j = 0; j < live.length; j++)
      if (micro.messages[j] !== live[j]) carry(live[j], micro.messages[j])
  const working = micro.cleared > 0 ? micro.messages : live

  /** Everything this call is prepared to do short of summarising. Nothing is
   * folded, so every still-sent position takes its rewritten copy: splitAt 0. */
  const losslessOnly = (): CompactionResult =>
    micro.cleared > 0
      ? { messages: rebuild(messages, liveAt, working, 0, null), folded: [], header: null }
      : unchanged()

  if (micro.cleared > 0 && threshold && estimateTokens(working) <= threshold) {
    return losslessOnly()
  }

  // Pass 2 — summarise the old part, keep the recent turns verbatim. Replacing
  // the WHOLE history with prose is what makes long sessions lose detail: the
  // work in progress right now is exactly what must stay exact.
  const splitAt = keepRecentTurns > 0 ? tailStart(working, keepRecentTurns) : working.length
  const toSummarise = working.slice(0, splitAt)
  const tail = working.slice(splitAt)
  if (toSummarise.length < 2) return losslessOnly()

  try {
    // Three refusals in a row for this chat and the attempt is abandoned; the
    // lossless pass above has already run and is kept either way.
    if (!allowSummary) return losslessOnly()

    const compactPrompt = terseHint
      ? `${getCompactPrompt()}\n\n${terseHint}`
      : getCompactPrompt()
    const resp = await adapter.complete(
      {
        model,
        system:
          'You summarize the conversation so it can continue within the context window. Output text only; do not call tools.',
        messages: [
          ...toSummarise,
          { role: 'user', content: compactPrompt },
        ],
        max_tokens: Math.min(maxTokens || SUMMARY_MAX_TOKENS, SUMMARY_MAX_TOKENS),
        temperature: 0,
      },
      signal,
    )
    const summary = formatCompactSummary(extractText(resp)).trim()
    if (!summary) return losslessOnly()
    const header: LLMMessage = {
      role: 'user',
      content:
        (tail.length > 0
          ? '[The earlier part of this conversation was summarized to stay within the ' +
            'context window. The most recent exchanges follow it verbatim.]\n\n'
          : '[The earlier conversation was automatically summarized to stay within the ' +
            'context window. Continue from this summary.]\n\n') + summary,
    }
    // A summary can be LONGER than the exchanges it replaces: the compact
    // prompt asks for a structured account, and that has a floor of several
    // hundred tokens whatever it is summarising. Accepting one is the worst
    // of every world — a model call spent, detail lost, and the context still
    // over the threshold, so the next turn compacts again, this time
    // summarising the summary. Measured live: 438 tokens in, 951 out.
    //
    // Measured on what the model would be SENT afterwards — the summary plus
    // the verbatim tail — because the folded messages stay in the array and
    // counting those would compare the new context against itself.
    if (estimateTokens([header, ...tail]) >= estimateTokens(working))
      return losslessOnly()
    return {
      messages: rebuild(messages, liveAt, working, splitAt, header),
      folded: live.slice(0, splitAt),
      header,
    }
  } catch (err) {
    // Even when summarising fails, the lossless pass is still a win — but the
    // caller has to hear about it, or the next turn pays for the same refusal.
    onSummaryError?.(err)
    return losslessOnly()
  }
}

/**
 * The conversation with the summary in it, and NOTHING taken out.
 *
 * `working[j]` is what became of the j-th still-sent message; the first
 * `splitAt` of those are what the summary now stands for. Those keep their
 * place, their content and their object identity, and the header goes in
 * directly after the last of them, so it sits where the summarised stretch
 * ended and immediately before the verbatim tail.
 *
 * Note which copy each position gets. The tail gets `working[j]` — the
 * micro-compacted one, since that is what will be sent. The folded stretch
 * gets the ORIGINAL: it is about to stop being sent, so its size no longer
 * matters, and keeping it whole is what lets an undo put the conversation
 * back as it was rather than as it had been trimmed to.
 *
 * Everything the model was already not being sent keeps its place too — that
 * object identity is what carries its id and its "removed" flag, so a prompt
 * taken out of context before a compaction is still out of context, and still
 * restorable, after one.
 */
function rebuild(
  original: LLMMessage[],
  liveAt: number[],
  working: LLMMessage[],
  splitAt: number,
  header: LLMMessage | null,
): LLMMessage[] {
  const position = new Map<number, number>()
  liveAt.forEach((at, j) => position.set(at, j))
  // Where the header goes: after the last message it stands for.
  const lastFolded = splitAt > 0 ? liveAt[splitAt - 1] : -1
  const out: LLMMessage[] = []
  if (header && lastFolded < 0) out.push(header)
  for (let i = 0; i < original.length; i++) {
    const j = position.get(i)
    out.push(j === undefined || j < splitAt ? original[i] : working[j])
    if (header && i === lastFolded) out.push(header)
  }
  return out
}

/**
 * Index of the message that starts the last `turns` user turns — the verbatim
 * tail. Splitting on a user message keeps assistant/tool pairs together; a cut
 * between a tool_use and its tool_result would be an invalid transcript.
 */
function tailStart(messages: LLMMessage[], turns: number): number {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      // Only count REAL user turns: a tool_result is delivered as a user
      // message, and counting those would cut the tail mid-tool-call.
      const c = messages[i].content
      const isToolResult =
        Array.isArray(c) && c.some(b => b.type === 'tool_result')
      if (isToolResult) continue
      if (++seen >= turns) return i
    }
  }
  return 0
}

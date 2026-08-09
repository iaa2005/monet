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

import { getCompactPrompt, formatCompactSummary } from '@vendor/services/compact/prompt.js'
import type { LLMAdapter, LLMMessage } from '../llm/adapter.js'
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
const SUMMARY_MAX_TOKENS = 8_000

/** Rough token estimate (chars/4) across our message content shapes. */
export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_result')
        chars += typeof b.content === 'string' ? b.content.length : 0
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length
      else if (b.type === 'image') chars += 2_000 // flat estimate per image
    }
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
 * Summarize the conversation and return a fresh, compact message[] (a single
 * user message carrying the summary) that the loop continues from. On any
 * failure the original messages are returned unchanged (compaction is
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
}): Promise<LLMMessage[]> {
  const {
    messages,
    adapter,
    model,
    maxTokens,
    signal,
    terseHint,
    threshold,
    keepRecentTurns = 2,
    carry,
  } = opts
  const inContext = opts.inContext ?? ((): boolean => true)

  // Where each still-sent message sits in the full list, so the compacted
  // result can be woven back among the ones that were left out.
  const liveAt: number[] = []
  for (let i = 0; i < messages.length; i++)
    if (inContext(messages[i])) liveAt.push(i)
  const live = liveAt.map(i => messages[i])
  if (live.length < 4) return messages

  // Pass 1 — lossless. Clearing replayable tool output is often enough on its
  // own, and it costs no model call and loses nothing that was SAID.
  const micro = microCompact(live)
  if (micro.cleared > 0 && carry)
    for (let j = 0; j < live.length; j++)
      if (micro.messages[j] !== live[j]) carry(live[j], micro.messages[j])
  const working = micro.cleared > 0 ? micro.messages : live

  /** Everything this call is prepared to do short of summarising. Returns the
   * ORIGINAL array when even that changed nothing, so the caller can tell
   * "compaction happened" from "compaction had nothing to give". */
  const losslessOnly = (): LLMMessage[] =>
    micro.cleared > 0 ? weave(messages, liveAt, working, 0, null) : messages

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
    const compacted = weave(messages, liveAt, working, splitAt, header)
    if (estimateTokens(compacted.filter(inContext)) >= estimateTokens(working))
      return losslessOnly()
    return compacted
  } catch {
    // Even when summarising fails, the lossless pass is still a win.
    return losslessOnly()
  }
}

/**
 * Put the compacted conversation back among the messages that were left out
 * of it.
 *
 * `working[j]` is what became of the j-th still-sent message; the first
 * `splitAt` of those were folded into `header` and the rest survive verbatim.
 * Everything the model is no longer sent keeps its place and its object
 * identity — that identity is what carries its id and its "removed" flag, so
 * a prompt taken out of context before a compaction is still out of context,
 * and still restorable, after one.
 */
function weave(
  original: LLMMessage[],
  liveAt: number[],
  working: LLMMessage[],
  splitAt: number,
  header: LLMMessage | null,
): LLMMessage[] {
  const position = new Map<number, number>()
  liveAt.forEach((at, j) => position.set(at, j))
  const out: LLMMessage[] = []
  let placed = header === null
  for (let i = 0; i < original.length; i++) {
    const j = position.get(i)
    if (j === undefined) {
      out.push(original[i]) // not being sent: untouched, in place
      continue
    }
    if (j < splitAt) {
      // Folded into the summary, which takes the place of the first of them.
      if (!placed) {
        out.push(header as LLMMessage)
        placed = true
      }
      continue
    }
    out.push(working[j])
  }
  if (!placed) out.push(header as LLMMessage)
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

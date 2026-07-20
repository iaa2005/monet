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

/** Compaction trigger for a model's input budget.
 *
 * The numeric form is kept for callers that already pass a resolved input
 * budget. The object form preserves the distinction between max input tokens
 * and total context length, reserving output space only for the latter.
 */
export function compactionThreshold(
  budget?: number | CompactionBudget,
): number {
  if (EXPLICIT_THRESHOLD != null) return EXPLICIT_THRESHOLD

  if (typeof budget === 'number') {
    return validLimit(budget)
      ? Math.floor(budget * 0.7)
      : DEFAULT_THRESHOLD
  }

  if (!budget) return DEFAULT_THRESHOLD
  if (validLimit(budget.inputLimit))
    return Math.floor(budget.inputLimit * 0.7)

  if (validLimit(budget.contextLimit)) {
    const reserve = validLimit(budget.outputReserve)
      ? Math.min(budget.outputReserve, budget.contextLimit)
      : Math.min(DEFAULT_OUTPUT_RESERVE, budget.contextLimit)
    const inputBudget = Math.max(1, budget.contextLimit - reserve)
    return Math.floor(inputBudget * 0.7)
  }

  return DEFAULT_THRESHOLD
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
}): Promise<LLMMessage[]> {
  const { messages, adapter, model, maxTokens, signal, terseHint } = opts
  if (messages.length < 4) return messages

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
          ...messages,
          { role: 'user', content: compactPrompt },
        ],
        max_tokens: Math.min(maxTokens || SUMMARY_MAX_TOKENS, SUMMARY_MAX_TOKENS),
        temperature: 0,
      },
      signal,
    )
    const summary = formatCompactSummary(extractText(resp)).trim()
    if (!summary) return messages
    return [
      {
        role: 'user',
        content:
          '[The earlier conversation was automatically summarized to stay within the ' +
          'context window. Continue from this summary.]\n\n' +
          summary,
      },
    ]
  } catch {
    return messages
  }
}

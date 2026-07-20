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

// Trigger compaction when the estimated input tokens exceed this. Kept high so
// it only fires on genuinely long sessions; override for smaller-context
// providers (e.g. deepseek) via MONET_COMPACT_TOKENS.
const DEFAULT_THRESHOLD = Number(process.env.MONET_COMPACT_TOKENS) || 150_000

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

/** Compaction trigger for a model's input budget (its max input tokens or
 * context length): 70% of the budget, but never above the global default. */
export function compactionThreshold(budget?: number): number {
  if (!budget || !Number.isFinite(budget) || budget <= 0)
    return DEFAULT_THRESHOLD
  return Math.min(DEFAULT_THRESHOLD, Math.floor(budget * 0.7))
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

/**
 * The empty-reply nudge: when it fires, when it refuses, and where the "."
 * lands.
 *
 * A bug here is either a silently dead run (the nudge never fires) or a
 * money-burning loop (it fires forever) — so the refusals get most of the
 * tests, the same way the goal driver's exits do.
 *
 *   npm run smoke:emptyturn
 */

import type { LLMMessage } from '../src/main/llm/adapter.js'
import {
  appendNudge,
  isEmptyReply,
  MAX_NUDGES,
  NUDGE,
  shouldNudge,
  stopReasonLabel,
} from '../src/main/agent/empty-turn.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── What counts as nothing ─────────────────────────────────────────────

check('no text and no tools is an empty reply', isEmptyReply('', 0))
check('whitespace is still nothing', isEmptyReply('  \n\t ', 0))
check('text is an answer', !isEmptyReply('done', 0))
check(
  'a tool call is work, even with no text',
  !isEmptyReply('', 1),
)

// ─── When the nudge fires ───────────────────────────────────────────────

const state = (o: Partial<Parameters<typeof shouldNudge>[0]> = {}) => ({
  emptyReply: true,
  nudgesUsed: 0,
  nudgedLastTurn: false,
  ...o,
})

check('an empty reply gets nudged', shouldNudge(state()))
check('a real answer does not', !shouldNudge(state({ emptyReply: false })))
check(
  'two empties in a row stop the run — the nudge did not take',
  !shouldNudge(state({ nudgesUsed: 1, nudgedLastTurn: true })),
)
check(
  'but an empty later in the run, after real work, is nudged again',
  shouldNudge(state({ nudgesUsed: 1, nudgedLastTurn: false })),
)
check(
  'the per-run budget is the ceiling',
  !shouldNudge(state({ nudgesUsed: MAX_NUDGES })),
)
check('and the budget is small', MAX_NUDGES <= 2, MAX_NUDGES)

// ─── Where the "." lands ────────────────────────────────────────────────

{
  // The dominant case: the turn that came back empty left tool results as the
  // last message. The nudge must JOIN them, not become a second user turn.
  const messages: LLMMessage[] = [
    { role: 'user', content: 'do the thing' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'tab list' },
      ],
    },
  ]
  const where = appendNudge(messages)
  const last = messages[messages.length - 1]!
  check('it merges into the tool results', where === 'merged', where)
  check('no new turn is created', messages.length === 2, messages.length)
  check(
    'and the nudge is a text block beside them',
    Array.isArray(last.content) &&
      last.content.length === 2 &&
      last.content[1]!.type === 'text' &&
      (last.content[1] as { text: string }).text === NUDGE,
    last.content,
  )
}

{
  // An empty FIRST reply: the last message is the user's own prompt, as a
  // plain string. Their words must survive verbatim, and the roles must not
  // end up user-then-user.
  const messages: LLMMessage[] = [{ role: 'user', content: 'сделай график' }]
  const where = appendNudge(messages)
  const last = messages[messages.length - 1]!
  check('a string prompt is widened, not replaced', where === 'merged')
  check('still one turn', messages.length === 1)
  check(
    'the user\'s words are kept as their own block',
    Array.isArray(last.content) &&
      (last.content[0] as { text: string }).text === 'сделай график' &&
      (last.content[1] as { text: string }).text === NUDGE,
    last.content,
  )
}

{
  // Not a shape the loop produces — but losing the run would be worse than
  // an extra turn.
  const messages: LLMMessage[] = [{ role: 'assistant', content: 'hm' }]
  check('an assistant tail gets a real user turn', appendNudge(messages) === 'pushed')
  check('which carries the nudge', messages[1]!.content === NUDGE)
}

check('the nudge is what a person would type', NUDGE === '.')

// ─── What gets written down ─────────────────────────────────────────────

check(
  'an ordinary end is recorded plainly',
  stopReasonLabel('end_turn', false) === 'end_turn',
)
check(
  'a model that gave up is distinguishable',
  stopReasonLabel('end_turn', true) === 'end_turn (empty reply)',
)
check(
  'so is a budget that ate the answer',
  stopReasonLabel('max_tokens', true) === 'max_tokens (empty reply)',
)
check(
  'a provider that says nothing still gets a word',
  stopReasonLabel(undefined, false) === 'unknown',
)

console.log(failures === 0 ? '\nALL EMPTY-TURN CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

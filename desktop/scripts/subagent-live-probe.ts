/**
 * The expanded sub-agent panel shows the child as it is NOW.
 *
 * It used to be handed a copy of the messages at click time, so a child that
 * was still working wrote into an array nobody was watching: the panel froze
 * and only closing and reopening it helped. The panel now holds an id, and
 * this is the lookup it does on every render — including into a sub-agent's
 * own sub-agents, which have the same expand button.
 *
 *   npm run smoke:subagent
 */

import {
  findSubAgentCall,
  subAgentView,
} from '../src/renderer/lib/subagent.js'
import type { ChatMessage } from '../src/renderer/types/chat.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const child = (text: string): ChatMessage =>
  ({ id: 'm-' + text, role: 'assistant', content: text }) as ChatMessage

const transcript = (childMessages: ChatMessage[]): ChatMessage[] =>
  [
    { id: 'u1', role: 'user', content: 'go' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCall: {
        id: 'call-1',
        name: 'Task',
        input: { description: 'audit the repo', subagent_type: 'Explore' },
        status: 'running',
        subAgent: {
          agentType: 'Explore',
          description: 'audit the repo',
          status: 'running',
          messages: childMessages,
        },
      },
    },
  ] as ChatMessage[]

// ─── It follows the transcript ──────────────────────────────────────────

const early = transcript([child('first step')])
check(
  'the call is found by id',
  findSubAgentCall(early, 'call-1')?.name === 'Task',
)
check(
  'and its state is the one in the transcript',
  subAgentView(findSubAgentCall(early, 'call-1'))?.messages.length === 1,
)

const later = transcript([child('first step'), child('second step'), child('done')])
check(
  'a later transcript shows the later state — no snapshot in between',
  subAgentView(findSubAgentCall(later, 'call-1'))?.messages.length === 3,
  subAgentView(findSubAgentCall(later, 'call-1'))?.messages.map((m) => m.content),
)

check(
  'the same object is returned, so React can compare by identity',
  findSubAgentCall(later, 'call-1') === later[1].toolCall,
)

// ─── Nesting ────────────────────────────────────────────────────────────

const nested = transcript([
  child('looking'),
  {
    id: 'c2',
    role: 'assistant',
    content: '',
    toolCall: {
      id: 'call-2',
      name: 'Task',
      input: { description: 'inner', subagent_type: 'general-purpose' },
      status: 'running',
      subAgent: {
        agentType: 'general-purpose',
        description: 'inner',
        status: 'running',
        messages: [child('inner step')],
      },
    },
  } as ChatMessage,
])
check(
  "a sub-agent's own sub-agent is reachable",
  subAgentView(findSubAgentCall(nested, 'call-2'))?.description === 'inner',
)

// ─── Edge cases the panel must survive ──────────────────────────────────

check('an id that is gone returns null', findSubAgentCall(later, 'call-9') === null)
check('and null renders as nothing', subAgentView(null) === null)
check('an empty transcript is not a crash', findSubAgentCall([], 'call-1') === null)

const notYetReported = [
  {
    id: 'a2',
    role: 'assistant',
    content: '',
    toolCall: {
      id: 'call-3',
      name: 'Task',
      input: { description: 'just launched', subagent_type: 'Plan' },
      status: 'running',
    },
  },
] as ChatMessage[]
const view = subAgentView(findSubAgentCall(notYetReported, 'call-3'))
check(
  'a call that has not reported yet still has a name and a description',
  view?.agentType === 'Plan' && view.description === 'just launched' && view.status === 'running',
  view,
)
const finished = [
  {
    ...notYetReported[0],
    toolCall: { ...notYetReported[0].toolCall!, status: 'done' },
  },
] as ChatMessage[]
check(
  'and it stops claiming to be running once the call is done',
  subAgentView(findSubAgentCall(finished, 'call-3'))?.status === 'done',
)

console.log(failures === 0 ? '\nsub-agent probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

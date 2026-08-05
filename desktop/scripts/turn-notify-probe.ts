/**
 * When a finished chat is allowed to interrupt you.
 *
 * Every branch here is a decision about tapping a person on the shoulder, so
 * each one is pinned: routines stay silent, a Stop press stays silent, a chat
 * you are watching stays silent, and the two cases where you could not have
 * seen the answer — window away, or a different chat open — do fire.
 *
 *   npm run smoke:turnnotify
 */

import {
  shouldNotifyTurnEnd,
  notificationBody,
  type TurnEndFacts,
} from '../src/main/app/turn-notify.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

/** Watching the chat that just finished, window up front: the quiet case. */
const watching: TurnEndFacts = {
  sessionId: 's1',
  visibleSessionId: 's1',
  windowFocused: true,
  windowVisible: true,
  isRoutineChat: false,
  aborted: false,
}
const facts = (over: Partial<TurnEndFacts>): TurnEndFacts => ({ ...watching, ...over })

// ─── Silence ────────────────────────────────────────────────────────────

check(
  'watching it happen: no notification',
  shouldNotifyTurnEnd(watching).notify === false,
  shouldNotifyTurnEnd(watching),
)

check(
  'a routine never notifies, even hidden behind another app',
  shouldNotifyTurnEnd(
    facts({ isRoutineChat: true, windowFocused: false, windowVisible: false }),
  ).notify === false,
)

check(
  'a routine never notifies, even with another chat on screen',
  shouldNotifyTurnEnd(facts({ isRoutineChat: true, visibleSessionId: 's2' })).notify ===
    false,
)

check(
  'you pressed Stop: you are at the keyboard, no notification',
  shouldNotifyTurnEnd(facts({ aborted: true, windowFocused: false, windowVisible: false }))
    .notify === false,
)

// ─── Interruption ───────────────────────────────────────────────────────

check(
  'window behind another app: notify (window-away)',
  shouldNotifyTurnEnd(facts({ windowFocused: false })).notify === true &&
    shouldNotifyTurnEnd(facts({ windowFocused: false })).because === 'window-away',
  shouldNotifyTurnEnd(facts({ windowFocused: false })),
)

check(
  'window closed to the tray / minimised: notify (window-away)',
  shouldNotifyTurnEnd(facts({ windowVisible: false, windowFocused: false })).because ===
    'window-away',
)

check(
  'hidden to the tray while the OS still calls it focused: notify',
  shouldNotifyTurnEnd(facts({ windowVisible: false })).because === 'window-away',
  shouldNotifyTurnEnd(facts({ windowVisible: false })),
)

check(
  'a hidden window wins over the chat check',
  shouldNotifyTurnEnd(
    facts({ windowVisible: false, windowFocused: false, visibleSessionId: 's2' }),
  ).because === 'window-away',
)

check(
  'switched to another chat: notify (other-chat)',
  shouldNotifyTurnEnd(facts({ visibleSessionId: 's2' })).because === 'other-chat',
  shouldNotifyTurnEnd(facts({ visibleSessionId: 's2' })),
)

check(
  'no chat open at all still counts as another chat',
  shouldNotifyTurnEnd(facts({ visibleSessionId: undefined })).because === 'other-chat',
)

// ─── The body ───────────────────────────────────────────────────────────

check(
  'the first non-empty line is the body',
  notificationBody('\n\n  Done: the report is written.\nMore below.') ===
    'Done: the report is written.',
  notificationBody('\n\n  Done: the report is written.\nMore below.'),
)

const long = 'x'.repeat(400)
const body = notificationBody(long)
check(
  'a long line is cut to something a toast can hold',
  body.length === 140 && body.endsWith('…'),
  { len: body.length },
)

check(
  'an error replaces the text',
  notificationBody('some reply', 'provider refused the request') ===
    'provider refused the request',
)

check('an empty reply still says something', notificationBody('   \n  ') === 'Finished.')

console.log(failures === 0 ? '\nturn-notify probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

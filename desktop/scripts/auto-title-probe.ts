/**
 * Naming a fresh chat: the two decisions from src/main/session/auto-title.ts.
 *
 * Both had a live failure behind them — a chat that keeps its opening line as
 * its name forever, and a reasoning model whose answer arrives after its
 * thinking — so both are pinned here.
 *
 *   npm run smoke:autotitle
 */

import {
  isUntitled,
  cleanTitle,
  TITLE_PLACEHOLDER,
} from '../src/main/session/auto-title.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Is it named yet ────────────────────────────────────────────────────

check('a brand new row has no name', isUntitled(undefined) && isUntitled(''))
check('whitespace is not a name', isUntitled('   '))
check('the placeholder is not a name', isUntitled(TITLE_PLACEHOLDER))
check(
  'a real name is a name — a rename must survive the turn',
  !isUntitled('Умножение 17 на 23'),
)
check(
  'the provisional stamp counts as named once written — which is why the '
    + 'question is asked before the turn, not after',
  !isUntitled('Посчитай, сколько будет 17 * 23'),
)

// ─── What came back ─────────────────────────────────────────────────────

check(
  'a plain answer is the name',
  cleanTitle('Умножение 17 на 23') === 'Умножение 17 на 23',
  cleanTitle('Умножение 17 на 23'),
)

check(
  'quotes the model added are not part of the name',
  cleanTitle('"Fixing the OAuth loop"') === 'Fixing the OAuth loop',
  cleanTitle('"Fixing the OAuth loop"'),
)

check(
  'thinking that leaked in: the name is the LAST line, not the first',
  cleanTitle(
    'The user asks about multiplication.\nI should answer briefly.\nУмножение 17 на 23',
  ) === 'Умножение 17 на 23',
  cleanTitle('a\nb\nУмножение 17 на 23'),
)

check(
  'trailing blank lines do not become the name',
  cleanTitle('Умножение 17 на 23\n\n  \n') === 'Умножение 17 на 23',
)

check(
  'a long name is cut to what a sidebar row holds',
  cleanTitle('x'.repeat(200)).length === 60,
  cleanTitle('x'.repeat(200)).length,
)

check('an empty reply names nothing', cleanTitle('   \n \n') === '')
check('a non-string reply names nothing', cleanTitle(undefined) === '')

console.log(failures === 0 ? '\nauto-title probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

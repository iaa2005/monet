/**
 * When the composer's placeholder may be drawn.
 *
 * The bug this pins down was visible: paste anything with a line break and
 * the placeholder came back ON TOP of the pasted text. The cause was a CSS
 * selector — `:has(> br:only-child)` — where `:only-child` counts ELEMENTS,
 * not nodes, so `text <br> text` still had the <br> as its only element
 * child and matched. The decision now lives in TS, and every shape below is
 * a real serialization produced by TokenInput's own serialize().
 *
 *   npm run smoke:composer
 */

import { isComposerEmpty } from '../src/renderer/lib/composer-empty.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Empty, and the one shape that only LOOKS like content ──────────────

check('a box with nothing in it is empty', isComposerEmpty(''))
// Chrome leaves <br> behind when the last character is deleted; serialize()
// renders that as a single newline. Visually the box is blank.
check('the stray <br> Chrome leaves behind still counts as empty', isComposerEmpty('\n'))

// ─── Content, however it got there ──────────────────────────────────────

check('a word is not empty', !isComposerEmpty('Привет'))
// THE regression: pasted two lines → text <br> text.
check(
  'two pasted lines are NOT empty (the <br> is not alone)',
  !isComposerEmpty('первая строка\nвторая строка'),
)
check(
  'a line plus a trailing break is not empty either',
  !isComposerEmpty('строка\n'),
)
check(
  'a paste ending in a blank line is not empty',
  !isComposerEmpty('строка\n\n'),
)
check(
  'a break BEFORE text is not empty',
  !isComposerEmpty('\nстрока'),
)
check('two breaks and nothing else are not "the stray br"', !isComposerEmpty('\n\n'))
check('a chip token alone is content', !isComposerEmpty('⟨App.tsx⟩'))
check('a bare space is content', !isComposerEmpty(' '))

console.log(failures === 0 ? '\nALL COMPOSER-EMPTY CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

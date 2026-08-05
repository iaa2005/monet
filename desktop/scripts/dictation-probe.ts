/**
 * The seam between two dictated fragments.
 *
 * The regression this pins down was visible and infuriating: pseudo-streaming
 * dictation appended onto a STALE snapshot of the input, so the second
 * fragment erased the first (and anything typed in between). The append path
 * now reads the live editor, and this file covers the other half — where the
 * space, or the full stop, actually goes.
 *
 *   npm run smoke:dictation
 */

import { joinDictation } from '../src/renderer/lib/dictation.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}
const eq = (name: string, got: string, want: string): void =>
  check(name, got === want, { got, want })

// ─── Nothing to join to ─────────────────────────────────────────────────

eq('an empty box takes the fragment as-is', joinDictation('', 'Привет'), 'Привет')
eq('an empty fragment changes nothing', joinDictation('Привет', '   '), 'Привет')
eq('the fragment is trimmed', joinDictation('', '  Привет  '), 'Привет')

// ─── Two sentences across a pause ───────────────────────────────────────
//
// GigaAM punctuates every fragment as a whole utterance: capitalised, and
// with no full stop at the end. Two of them run together read as one
// run-on sentence — so the seam supplies the stop the model omitted.

eq(
  'a capitalised fragment after a word gets a full stop',
  joinDictation('Открой файл', 'Проверь тесты'),
  'Открой файл. Проверь тесты',
)
eq(
  'a lower-case fragment is a continuation, not a new sentence',
  joinDictation('открой файл', 'и проверь тесты'),
  'открой файл и проверь тесты',
)
eq(
  'a digit starts a sentence too',
  joinDictation('Смотри', '42 строки'),
  'Смотри. 42 строки',
)

// ─── Punctuation already present ────────────────────────────────────────

eq(
  'an existing full stop is not doubled',
  joinDictation('Готово.', 'Дальше'),
  'Готово. Дальше',
)
eq(
  'a comma keeps its single space',
  joinDictation('Сначала это,', 'потом то'),
  'Сначала это, потом то',
)
eq(
  'a fragment that STARTS with punctuation glues on',
  joinDictation('Сначала это', ', потом то'),
  'Сначала это, потом то',
)
eq(
  'a closing bracket glues on too',
  joinDictation('Проверь (файл', ') и запусти'),
  'Проверь (файл) и запусти',
)
eq(
  'an opening bracket binds rightwards',
  joinDictation('Смотри (', 'вот тут'),
  'Смотри (вот тут',
)
eq(
  'a hyphen binds rightwards',
  joinDictation('какой-то из-', 'за угла'),
  'какой-то из-за угла',
)

// ─── The user's own layout wins ─────────────────────────────────────────

eq(
  'a trailing space is respected, not doubled',
  joinDictation('Сделай ', 'вот это'),
  'Сделай вот это',
)
eq(
  'a trailing newline is a deliberate line break',
  joinDictation('Первый пункт\n', 'Второй пункт'),
  'Первый пункт\nВторой пункт',
)
eq(
  'a blank line survives',
  joinDictation('Абзац\n\n', 'Новый абзац'),
  'Абзац\n\nНовый абзац',
)

// ─── Latin text behaves the same ────────────────────────────────────────

eq(
  'English sentences get the same stop',
  joinDictation('Open the file', 'Run the tests'),
  'Open the file. Run the tests',
)
eq(
  'and lower-case English continues',
  joinDictation('open the file', 'and run the tests'),
  'open the file and run the tests',
)

// ─── Chaining several fragments, the real scenario ──────────────────────

{
  const parts = ['Открой проект', 'проверь линтер', 'Потом собери']
  const out = parts.reduce((acc, p) => joinDictation(acc, p), '')
  eq(
    'three fragments in a row read as intended',
    out,
    'Открой проект проверь линтер. Потом собери',
  )
  check('and nothing was lost', parts.every((p) => out.includes(p)), out)
}

// The typed-between-fragments case: the seam must not eat the typed text.
{
  const afterFirst = joinDictation('', 'Первое')
  const typed = `${afterFirst} и ещё руками`
  const out = joinDictation(typed, 'Второе')
  check('text typed between fragments survives', out.includes('и ещё руками'), out)
  eq('and the next fragment still joins cleanly', out, 'Первое и ещё руками. Второе')
}

console.log(failures === 0 ? '\nALL DICTATION CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

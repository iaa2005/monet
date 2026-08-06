/**
 * What a typed message shows as notation — and, more importantly, what it
 * does NOT.
 *
 * A user bubble is not a document: `#` is a hash, `*` is an asterisk. Only
 * code and maths are promoted, and the dangerous direction is over-matching
 * — "$5 и $10" turning a price list into a formula is the exact failure
 * lib/currency-dollars.ts was written for, and this parser inherits its
 * test.
 *
 *   npm run smoke:richtext
 */

import { parseRichText, looksLikeMaths } from '../src/renderer/lib/rich-text.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}
const kinds = (s: string): string => parseRichText(s).map((p) => p.kind).join(',')

// ─── Nothing to promote ─────────────────────────────────────────────────

check('plain prose is one text segment', kinds('просто текст') === 'text')
check(
  'markdown syntax stays literal — a message is not a document',
  kinds('# заголовок и *звёздочки* и [ссылка](x)') === 'text',
)

// ─── Code ───────────────────────────────────────────────────────────────

{
  const segs = parseRichText('вот `npm run build` тут')
  check('inline code is a span', kinds('вот `npm run build` тут') === 'text,code,text')
  check('…with the backticks stripped', segs[1].kind === 'code' && segs[1].value === 'npm run build', segs[1])
}
{
  const segs = parseRichText('До\n```ts\nconst x = 1;\n```\nПосле')
  const fence = segs.find((s) => s.kind === 'fence')
  check('a fence becomes a block', !!fence)
  check('…carrying its language', fence?.kind === 'fence' && fence.lang === 'ts', fence)
  check('…and its body, without the markers', fence?.kind === 'fence' && fence.value === 'const x = 1;', fence)
  check('text on both sides survives', kinds('До\n```ts\nconst x = 1;\n```\nПосле') === 'text,fence,text')
}
check('a fence with no language is still a fence', kinds('```\nplain\n```') === 'fence')
check(
  'a lone backtick is just a character',
  kinds('цена ` за штуку') === 'text',
)

// ─── Maths, and the money that is not maths ─────────────────────────────

check('inline maths is maths', kinds('энергия $E = mc^2$ вот') === 'text,math,text')
check('display maths too', kinds('$$x^2 + y^2 = z^2$$') === 'math')
check(
  'A PRICE IS NOT AN EQUATION',
  kinds('Стоит $5, а вот это $10') === 'text',
  parseRichText('Стоит $5, а вот это $10'),
)
check('nor is a thousands separator', kinds('Итого: $1,000 и $2,000 за год') === 'text')
check('nor a whole sentence of prices', kinds('$100 in, $200 out, $300 total') === 'text')
check(
  '$2x + 1$ IS maths (digit next to a letter)',
  kinds('вот $2x + 1$') === 'text,math',
  parseRichText('вот $2x + 1$'),
)
check('an escaped dollar opens nothing', kinds('стоит \\$5 и всё') === 'text')
check(
  'a span that spills over a blank line is prose',
  looksLikeMaths('a\n\nb') === false,
)
check('an empty span is not maths', looksLikeMaths('   ') === false)

// ─── Precedence: code wins ──────────────────────────────────────────────

check(
  'dollars inside inline code stay dollars',
  kinds('`price = $5 + $x^2`') === 'code',
  parseRichText('`price = $5 + $x^2`'),
)
check(
  'and inside a fence too',
  kinds('```sh\necho $HOME ^_{}\n```') === 'fence',
)
{
  const segs = parseRichText('```js\nconst a = 1;\n```\nи `b` и $c = 2$')
  check(
    'a message can hold all three kinds at once',
    segs.map((s) => s.kind).join(',') === 'fence,text,code,text,math',
    segs.map((s) => s.kind),
  )
}

console.log(failures === 0 ? '\nALL RICH-TEXT CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

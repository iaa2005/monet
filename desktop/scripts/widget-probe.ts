/**
 * A widget draws, and a broken one falls back to code.
 *
 * The second half is the one worth a probe. A renderer that swallows a
 * malformed payload leaves an empty space where an answer should be, and the
 * model gets no signal that it wrote something wrong — so every failure mode
 * here has to end in visible source, never in nothing.
 */

import { renderWidget, isWidgetLang, WIDGET_NAMES } from '../src/renderer/widgets/index.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const line = JSON.stringify({
  type: 'line',
  title: 'TSLA',
  labels: ['a', 'b', 'c'],
  series: [{ name: 'close', data: [1, 2, 3] }],
})
const candles = JSON.stringify({
  type: 'candlestick',
  labels: ['a', 'b'],
  series: [{ ohlc: [{ o: 1, h: 3, l: 0.5, c: 2 }, { o: 2, h: 4, l: 1, c: 1.5 }] }],
})

check('chart is a known widget language', isWidgetLang('chart'))
check('a plain language is not', !isWidgetLang('python') && !isWidgetLang(undefined))
check('the registry names itself', WIDGET_NAMES.includes('chart'))

check('a line chart renders', renderWidget('chart', line) !== null)
check('a candlestick chart renders', renderWidget('chart', candles) !== null)

// Everything below must return null — the caller then draws a code block.
check('unparseable JSON falls back', renderWidget('chart', '{ nope') === null)
check('a JSON scalar falls back', renderWidget('chart', '42') === null)
check('null falls back', renderWidget('chart', 'null') === null)
check(
  'an object without series falls back',
  renderWidget('chart', JSON.stringify({ type: 'line', labels: ['a'] })) === null,
)
check(
  'series of the wrong type falls back',
  renderWidget('chart', JSON.stringify({ series: 'nope' })) === null,
)
check('an unknown widget language falls back', renderWidget('tikz', line) === null)
check('no language falls back', renderWidget(undefined, line) === null)

// Empty data is not malformed — it renders, and says so. Falling back here
// would show the user raw JSON for a chart that simply had no rows.
check(
  'an empty series still renders (it reports "no data")',
  renderWidget('chart', JSON.stringify({ series: [] })) !== null,
)

console.log(failures === 0 ? '\nA CHART DRAWS, AND A BROKEN ONE STAYS VISIBLE' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)

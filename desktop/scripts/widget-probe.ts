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

check('a chart with volume renders', renderWidget('chart', JSON.stringify({
  type: 'candlestick', labels: ['a', 'b'],
  ohlc: [[1, 2, 0.5, 1.5], [1.5, 3, 1, 2]],
  volume: [1000, 2000],
})) !== null)

check('chart is a known widget language', isWidgetLang('chart'))
check('a plain language is not', !isWidgetLang('python') && !isWidgetLang(undefined))
check('the registry names itself', WIDGET_NAMES.includes('chart'))

check('a line chart renders', renderWidget('chart', line) !== null)
check('a candlestick chart renders', renderWidget('chart', candles) !== null)

// The shapes a model actually writes. The first real chart came out with
// `ohlc` at the TOP level and rows as arrays, and fell back to a code block:
// the instruction said "give ohlc instead of data", which reads equally well
// as replacing the series. These are that payload, verbatim in shape.
check(
  'top-level ohlc with array rows renders',
  renderWidget(
    'chart',
    JSON.stringify({
      type: 'candlestick',
      title: 'TSLA',
      labels: ['2026-07-13', '2026-07-14'],
      ohlc: [
        [404.61, 405.57, 391.37, 394.76],
        [399.05, 402.22, 394.76, 396.18],
      ],
    }),
  ) !== null,
)
check(
  'top-level data renders as one series',
  renderWidget(
    'chart',
    JSON.stringify({ type: 'line', labels: ['a', 'b'], data: [1, 2] }),
  ) !== null,
)
check(
  "pandas' open/high/low/close naming renders",
  renderWidget(
    'chart',
    JSON.stringify({
      type: 'candlestick',
      labels: ['a'],
      ohlc: [{ open: 1, high: 3, low: 0.5, close: 2 }],
    }),
  ) !== null,
)

// Everything below must return null — the caller then draws a code block.
// A block with `src` and no rows is a chart — the data lives in a sandbox
// file so the model never retypes it. It must NOT fall back to code just for
// having no numbers in it.
check(
  'a src-only block is a chart, not a code block',
  renderWidget('chart', JSON.stringify({ type: 'candlestick', title: 'TSLA', src: 'tsla.json' })) !== null,
)
check(
  'an empty src is not a chart',
  renderWidget('chart', JSON.stringify({ type: 'candlestick', src: '' })) === null,
)

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

// A chart in the history must keep the numbers it was drawn with. The model
// may write tsla.json three times in one chat; the answer given after the
// first write is not retroactively about the third. Artifacts keep one copy
// per write, so the rule is "newest at or before the message" — this is that
// selection, over the shape collectArtifacts produces.
{
  const pick = (
    items: { name: string; ts: number; path: string }[],
    want: string,
    asOf: number | undefined,
  ) =>
    asOf
      ? items
          .filter(a => a.name === want && a.ts <= asOf)
          .sort((x, y) => y.ts - x.ts)[0]
      : undefined

  const versions = [
    { name: 'tsla.json', ts: 1000, path: '/a/1000-tsla.json' },
    { name: 'tsla.json', ts: 2000, path: '/a/2000-tsla.json' },
    { name: 'tsla.json', ts: 3000, path: '/a/3000-tsla.json' },
    { name: 'other.json', ts: 2500, path: '/a/2500-other.json' },
  ]
  check(
    'a chart from the first turn keeps the first version',
    pick(versions, 'tsla.json', 1500)?.path === '/a/1000-tsla.json',
  )
  check(
    '…the second turn keeps the second',
    pick(versions, 'tsla.json', 2500)?.path === '/a/2000-tsla.json',
  )
  check(
    '…and the newest turn gets the newest',
    pick(versions, 'tsla.json', 9999)?.path === '/a/3000-tsla.json',
  )
  check(
    'a write at the same millisecond counts as already written',
    pick(versions, 'tsla.json', 2000)?.path === '/a/2000-tsla.json',
  )
  check(
    'another file is never picked',
    pick(versions, 'tsla.json', 9999)?.name === 'tsla.json',
  )
  check(
    'with nothing written yet there is no snapshot, and it falls back to live',
    pick(versions, 'tsla.json', 500) === undefined,
  )
}

console.log(failures === 0 ? '\nA CHART DRAWS, AND A BROKEN ONE STAYS VISIBLE' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)

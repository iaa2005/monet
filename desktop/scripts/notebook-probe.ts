/**
 * The notebook format: reading it, editing it, and — above all — writing it
 * back without losing anything.
 *
 * An editor that drops a field it did not understand corrupts real work
 * silently, so the round trip gets the most tests: unknown top-level keys,
 * kernel metadata, cell tags and ids all have to survive an edit that never
 * touched them.
 *
 *   npm run smoke:notebook
 */

import {
  cellText,
  clearOutputs,
  deleteCell,
  hasRenderableOutput,
  insertCell,
  moveCell,
  notebookLanguage,
  outputHtml,
  outputImage,
  outputText,
  parseNotebook,
  sanitizeOutputHtml,
  serializeNotebook,
  setCellSource,
  setCellType,
  stripAnsi,
  toSourceLines,
  type Notebook,
} from '../src/renderer/lib/notebook.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const RAW = {
  cells: [
    {
      cell_type: 'markdown',
      id: 'c1',
      metadata: { tags: ['intro'] },
      source: ['# Заголовок\n', '\n', 'Текст.'],
    },
    {
      cell_type: 'code',
      id: 'c2',
      execution_count: 3,
      metadata: { scrolled: true },
      source: ['import numpy as np\n', 'print(np.pi)'],
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['3.14159\n'] },
        {
          output_type: 'execute_result',
          execution_count: 3,
          data: { 'text/plain': ['3.14159'], 'image/png': 'iVBORw0KGgo=' },
          metadata: {},
        },
      ],
    },
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python', version: '3.14.5' },
    widgets: { 'application/vnd.jupyter.widget-state+json': { state: {} } },
  },
  nbformat: 4,
  nbformat_minor: 5,
}
const TEXT = JSON.stringify(RAW, null, 1)

// ─── Reading ────────────────────────────────────────────────────────────

const nb = parseNotebook(TEXT)!
check('a notebook parses', !!nb && nb.cells.length === 2)
check('JSON that is not a notebook is refused', parseNotebook('{"a":1}') === null)
check('and so is broken JSON', parseNotebook('{oops') === null)
check(
  'a cell body comes back as one string, newlines intact',
  cellText(nb.cells[1]!) === 'import numpy as np\nprint(np.pi)',
  cellText(nb.cells[1]!),
)
check('the language comes from the kernel', notebookLanguage(nb) === 'python')

// ─── Outputs ────────────────────────────────────────────────────────────

{
  const [stream, result] = nb.cells[1]!.outputs!
  check('stream text is readable', outputText(stream!) === '3.14159\n')
  check('an image output is found', outputImage(result!)?.mediaType === 'image/png')
  check(
    'and its base64 survives',
    outputImage(result!)?.base64 === 'iVBORw0KGgo=',
  )
  check('both are worth drawing', hasRenderableOutput(stream!) && hasRenderableOutput(result!))
  check(
    'an empty output is not',
    !hasRenderableOutput({ output_type: 'execute_result', data: {} }),
  )
  const err = {
    output_type: 'error',
    ename: 'ValueError',
    evalue: 'bad',
    traceback: ['[0;31mValueError[0m: bad'],
  }
  check(
    'a traceback reads as text, without the colour codes',
    outputText(err).includes('ValueError: bad') && !outputText(err).includes('[0;31m'),
    outputText(err),
  )
  check('ansi stripping leaves the words', stripAnsi('[1mhi[0m') === 'hi')
}

// ─── HTML outputs are shown, but not trusted ────────────────────────────

{
  const dirty =
    '<table><tr><td>1</td></tr></table>' +
    '<script>steal()</script>' +
    // Spaces inside the quotes on purpose: the unquoted rule cannot swallow
    // this one, so the quoted rule is the only thing standing between the
    // notebook and a handler that runs.
    '<img src=x onerror="alert( 1 )">' +
    "<a href='javascript:alert(2)'>x</a>"
  const clean = sanitizeOutputHtml(dirty)
  check('the table survives', clean.includes('<table>') && clean.includes('<td>1</td>'))
  check('the script does not', !/script/i.test(clean), clean)
  check('nor does an inline handler', !/onerror/i.test(clean), clean)
  check('nor a javascript: url', !/javascript:/i.test(clean), clean)
  check(
    'outputHtml runs it through the same filter',
    !/script/i.test(outputHtml({ output_type: 'display_data', data: { 'text/html': dirty } }) ?? ''),
  )
}

// ─── Writing it back ────────────────────────────────────────────────────

check('a body splits back into nbformat lines',
  JSON.stringify(toSourceLines('a\nb')) === JSON.stringify(['a\n', 'b']))
check('a trailing newline is kept on its line',
  JSON.stringify(toSourceLines('a\n')) === JSON.stringify(['a\n']))
check('an empty cell is an empty list', toSourceLines('').length === 0)

{
  const round = parseNotebook(serializeNotebook(nb))!
  check(
    'a round trip keeps every top-level key',
    JSON.stringify(Object.keys(round).sort()) ===
      JSON.stringify(Object.keys(RAW).sort()),
    Object.keys(round),
  )
  check(
    'and metadata this editor knows nothing about',
    JSON.stringify(round.metadata?.['widgets']) ===
      JSON.stringify(RAW.metadata.widgets),
  )
  check(
    'and the cells byte for byte',
    JSON.stringify(round.cells) === JSON.stringify(RAW.cells),
  )
  check('the file ends with a newline', serializeNotebook(nb).endsWith('\n'))
}

// ─── Editing ────────────────────────────────────────────────────────────

{
  const edited = setCellSource(nb, 1, 'print(1)\nprint(2)')
  check('an edit lands as lines',
    JSON.stringify(edited.cells[1]!.source) === JSON.stringify(['print(1)\n', 'print(2)']))
  check(
    'and leaves the cell\'s other fields alone',
    edited.cells[1]!.execution_count === 3 &&
      JSON.stringify(edited.cells[1]!.metadata) === JSON.stringify({ scrolled: true }),
  )
  check('the untouched cell is the SAME object', edited.cells[0] === nb.cells[0])
  check('and the original is unchanged', cellText(nb.cells[1]!).includes('numpy'))
}

{
  const added = insertCell(nb, 1, 'code')
  check('a cell can be inserted where asked', added.cells.length === 3 && added.cells[1]!.cell_type === 'code')
  check('a new code cell is empty and unrun',
    added.cells[1]!.execution_count === null && (added.cells[1]!.outputs ?? []).length === 0)
  check('and carries an id, as nbformat 4.5 wants', typeof added.cells[1]!.id === 'string')
}

{
  const moved = moveCell(nb, 0, 1)
  check('a cell moves down', moved.cells[1]!.id === 'c1' && moved.cells[0]!.id === 'c2')
  check('and cannot move off the end', moveCell(nb, 1, 1) === nb)
  check('nor off the start', moveCell(nb, 0, -1) === nb)
}

{
  check('a cell can be deleted', deleteCell(nb, 0).cells.length === 1)
  const one: Notebook = { cells: [nb.cells[0]!] }
  check('the last cell cannot — there would be nothing to edit', deleteCell(one, 0) === one)
}

{
  const asMd = setCellType(nb, 1, 'markdown')
  check('code turned to prose stops claiming a run',
    asMd.cells[1]!.execution_count === undefined && asMd.cells[1]!.outputs === undefined)
  check('and its text survives the change', cellText(asMd.cells[1]!).includes('numpy'))
  const back = setCellType(asMd, 1, 'code')
  check('turning it back gives it a clean slate',
    back.cells[1]!.execution_count === null && (back.cells[1]!.outputs ?? []).length === 0)
  check('a type that is already right changes nothing', setCellType(nb, 0, 'markdown').cells[0] === nb.cells[0])
}

{
  const cleared = clearOutputs(nb)
  check('clearing outputs empties them', (cleared.cells[1]!.outputs ?? []).length === 0)
  check('and forgets the execution count', cleared.cells[1]!.execution_count === null)
  check('markdown cells are left alone', cleared.cells[0] === nb.cells[0])
}

console.log(failures === 0 ? '\nALL NOTEBOOK CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

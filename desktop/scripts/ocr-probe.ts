/**
 * The OCR scanner, up to the model boundary.
 *
 * Pins the parts that decide WHAT runs and WHETHER it can: the catalogue's
 * arithmetic, the install plan (which files a weight variant needs, and what
 * happens when the repo does not publish one), the page-range parser the tool
 * hands the rasteriser, and the "is a model installed" check the tool list is
 * gated on.
 *
 * The model itself is not run here — a gigabyte of weights and two minutes a
 * page is not a smoke test. What IS pinned is that nothing claims to be
 * installed when it is not, because that is the failure the user would meet
 * as a tool that exists and always fails.
 *
 *   npm run smoke:ocr
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'ocr-probe-'))
setDataDir(tempData)

const { OCR_MODELS, ocrModel, ocrVariant, variantFiles, formatBytes, CONFIG_FILES } =
  await import('../src/main/ocr/catalog.js')
const { planInstall, isInstalledSync, modelDir } = await import(
  '../src/main/ocr/install.js'
)
const { getOcrConfig, setOcrConfig } = await import('../src/main/ocr/settings.js')
const { hasOcrModel } = await import('../src/main/ocr/ready.js')
const { parsePages } = await import('../src/main/ocr/tools.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── The catalogue ──────────────────────────────────────────────────────

const model = OCR_MODELS[0]
check('there is a default model', !!model && !!ocrModel(model.id))
check(
  'every variant says which devices it is CORRECT on',
  model.variants.every((v) => v.devices.length > 0),
  model.variants.map((v) => [v.dtype, v.devices]),
)
check(
  'the default variant runs on the CPU too',
  ocrVariant(model, 'q4')?.devices.includes('cpu') === true,
)
check(
  'no variant claims a device it was measured broken on',
  // q4f16 produced a page of "!" on both backends here. If it ever comes
  // back it must come back with evidence, not by accident.
  !model.variants.some((v) => (v.dtype as string) === 'q4f16'),
  model.variants.map((v) => v.dtype),
)
check('sizes read as sizes', formatBytes(725 * 1024 * 1024) === '725 MB', formatBytes(725 * 1024 * 1024))
check('and gigabytes as gigabytes', formatBytes(2_100 * 1024 * 1024) === '2.1 GB')

{
  const { required, optional } = variantFiles(model, 'q4')
  check(
    'a variant asks for one onnx per component',
    required.length === model.components.length &&
      required.every((p) => p.endsWith('_q4.onnx')),
    required,
  )
  check(
    'and treats the weight sidecars as optional',
    optional.every((p) => p.endsWith('_q4.onnx_data')),
    optional,
  )
}

// ─── The install plan ───────────────────────────────────────────────────

{
  const manifest = new Map<string, { path: string; size: number; sha256?: string }>()
  const add = (path: string, size: number, sha?: string): void => {
    manifest.set(path, { path, size, sha256: sha })
  }
  for (const f of CONFIG_FILES) add(f, 1000)
  for (const c of model.components) {
    add(`onnx/${c}_q4.onnx`, 400_000, 'abc')
    // Only ONE component gets a sidecar: the others must not be demanded.
    if (c === 'decoder_model_merged') add(`onnx/${c}_q4.onnx_data`, 390_000_000, 'def')
  }

  const plan = planInstall(model, 'q4', manifest)
  check(
    'the plan takes the configs, the onnx files and the sidecars that exist',
    plan.length === CONFIG_FILES.length + model.components.length + 1,
    plan.map((f) => f.path),
  )
  check(
    'a missing sidecar is not an error',
    !plan.some((f) => f.path === 'onnx/vision_encoder_q4.onnx_data'),
  )
  check(
    'the total is what the UI will promise',
    plan.reduce((n, f) => n + f.size, 0) ===
      CONFIG_FILES.length * 1000 + model.components.length * 400_000 + 390_000_000,
  )
  check('checksums travel with the plan', plan.some((f) => f.sha256 === 'def'))

  // A repo that does not publish the weights this variant needs is a broken
  // catalogue entry, and must say which file rather than 404 mid-download.
  const short = new Map(manifest)
  short.delete('onnx/vision_encoder_q4.onnx')
  let said = ''
  try {
    planInstall(model, 'q4', short)
  } catch (err) {
    said = err instanceof Error ? err.message : String(err)
  }
  check('a missing REQUIRED file names itself', said.includes('vision_encoder_q4.onnx'), said)

  // A config file the repo omits is normal (not every repo has a template).
  const noTemplate = new Map(manifest)
  noTemplate.delete('chat_template.jinja')
  check(
    'a missing config file is survivable',
    planInstall(model, 'q4', noTemplate).length === plan.length - 1,
  )
}

// ─── Page ranges, as people write them ──────────────────────────────────

check('a single page', parsePages('3').join() === '3')
check('a range', parsePages('2-5').join() === '2,3,4,5')
check('a mixture, sorted and deduplicated', parsePages('9,1,4-6,4').join() === '1,4,5,6,9')
check('a backwards range still means the pages between', parsePages('5-2').join() === '2,3,4,5')
check('spaces are not an error', parsePages(' 2 - 4 , 7 ').join() === '2,3,4,7')
check('nothing means the whole document', parsePages(undefined).length === 0)
check('nonsense means the whole document, not page NaN', parsePages('abc').length === 0)

// ─── "Is it installed" — the gate the tool list stands on ───────────────

{
  check('an empty data dir has no OCR model', !hasOcrModel())
  check('…and the tool is therefore not offered', !isInstalledSync(model, 'q4'))

  // Lay down everything the check demands, and it flips.
  const dir = modelDir(model)
  const { required } = variantFiles(model, 'q4')
  for (const path of [...required, 'config.json', 'tokenizer.json']) {
    const abs = join(dir, path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'x')
  }
  check('a complete variant reads as installed', isInstalledSync(model, 'q4'))
  check('…and the agent gets the tool', hasOcrModel())

  // A file that is still downloading is a `.part`, and must not count.
  rmSync(join(dir, required[0]))
  writeFileSync(join(dir, `${required[0]}.part`), 'half')
  check('a half-downloaded variant does NOT read as installed', !isInstalledSync(model, 'q4'))
  check('…so the tool goes away again', !hasOcrModel())

  // Another variant sharing the folder is not this one.
  writeFileSync(join(dir, required[0]), 'x')
  check('the installed variant is the one that was asked about', !isInstalledSync(model, 'fp16'))
}

// ─── Settings ───────────────────────────────────────────────────────────

{
  const cfg = getOcrConfig()
  check('defaults are the measured-good ones', cfg.dtype === 'q4' && cfg.device === 'auto', cfg)
  check('and a sane page resolution', cfg.dpi === 150)
  setOcrConfig({ dpi: 5000, maxPages: -3 })
  const clamped = getOcrConfig()
  check('an absurd DPI is clamped, not obeyed', clamped.dpi <= 300, clamped.dpi)
  check('and so is a negative page cap', clamped.maxPages >= 1, clamped.maxPages)
  setOcrConfig({ modelId: 'no-such-model' })
  check(
    'a model that does not exist falls back to one that does',
    !!ocrModel(getOcrConfig().modelId),
    getOcrConfig().modelId,
  )
}

// ─── PaddleOCR-VL: its own file names, its own runtime ──────────────────

{
  const paddle = OCR_MODELS.find((m) => m.id === 'paddleocr-vl')!
  check('the catalogue has the hand-written engine', !!paddle && paddle.engine === 'paddle')
  const files = variantFiles(paddle, 'q4')
  check(
    'it asks for the graphs by their real names',
    files.required.join() ===
      'onnx/vision_encoder_q4.onnx,onnx/decoder_q4.onnx,onnx/embedding.onnx',
    files.required,
  )
  check(
    'and never for a quantised embedding table, which does not exist',
    !files.required.concat(files.optional).some((f) => /embedding_q/.test(f)),
    files.required.concat(files.optional),
  )
}

// ─── OTSL, the table language Paddle answers in ─────────────────────────

{
  const { isOtsl, otslToMarkdown, parseOtsl } = await import(
    '../src/main/ocr/paddle/otsl.js'
  )
  const table =
    '<fcel>Параметр<fcel>Классический<fcel>Квантовый<nl>' +
    '<fcel>Единица<fcel>Бит<fcel>Кубит<nl>'
  check('OTSL is recognised', isOtsl(table))
  check('plain markdown is not', !isOtsl('| a | b |'))
  const rows = parseOtsl(table)
  check('rows and cells come out whole', rows.length === 2 && rows[0].length === 3, rows)
  const md = otslToMarkdown(table)
  const lines = md.split('\n')
  check('it becomes a markdown table', lines[0] === '| Параметр | Классический | Квантовый |', lines[0])
  check('…with a header rule', lines[1] === '| --- | --- | --- |', lines[1])
  // A model that loses its place emits a short row; markdown renders a
  // ragged table as gibberish, so the gap is filled rather than left.
  const ragged = otslToMarkdown('<fcel>a<fcel>b<fcel>c<nl><fcel>d<nl>')
  const raggedLines = ragged.split('\n')
  check('a short row is padded, not left ragged', raggedLines[2] === '| d |  |  |', raggedLines[2])
}

// ─── smart_resize, ported ───────────────────────────────────────────────

{
  const { smartResize } = await import('../src/main/ocr/paddle/preprocess.js')
  const FACTOR = 28

  // The rule that took four wrong versions to find: a picture under the
  // pixel floor is scaled UP. A cropped text line is 33 pixels tall, and at
  // that size the model reads letters by silhouette — "большом" comes back
  // as "обльшом".
  const line = smartResize(1072, 33)
  check('a small crop is ENLARGED, not squeezed', line.height > 33 && line.width > 1072, line)
  check('…to at least the pixel floor', line.width * line.height >= FACTOR * FACTOR * 130, line)
  check('every side is a whole block', line.width % FACTOR === 0 && line.height % FACTOR === 0, line)

  // A full page is over the ceiling and comes down.
  const page = smartResize(2480, 3508)
  check('a big page is reduced', page.width < 2480 && page.height < 3508, page)
  check('…to under the ceiling', page.width * page.height <= FACTOR * FACTOR * 1280, page)
  check('and stays on the grid', page.width % FACTOR === 0 && page.height % FACTOR === 0, page)

  // Aspect ratio survives roughly — it is rounded to the grid, not squashed.
  const wide = smartResize(2000, 500)
  check('a wide picture stays wide', wide.width > wide.height * 3, wide)

  const tiny = smartResize(10, 4)
  check('something smaller than one block still works', tiny.width >= FACTOR && tiny.height >= FACTOR, tiny)
}

// ─── Layout: what survives, in what order ───────────────────────────────

{
  const { dropNested, dropDuplicates, absorbInline, readingOrder } = await import(
    '../src/main/ocr/layout.js'
  )
  const box = (x1: number, y1: number, x2: number, y2: number) =>
    [x1, y1, x2, y2] as [number, number, number, number]
  const blk = (label: string, b: [number, number, number, number], score = 0.9) => ({
    label,
    score,
    box: b,
  })

  // A table full of formulas comes back as the table AND every formula in
  // it. Reading both prints the contents twice and pays twice.
  const table = blk('table', box(100, 100, 600, 600))
  const inTable = blk('formula', box(200, 200, 300, 240))
  const outside = blk('formula', box(100, 700, 500, 760))
  const kept = dropNested([table, inTable, outside])
  check('a formula inside a table is the table', !kept.includes(inTable), kept.map((b) => b.label))
  check('…and one outside it survives', kept.includes(outside))
  check('…and the table itself stays', kept.includes(table))

  // A caption is detected as figure_title AND text on the same pixels.
  const caption = blk('figure_title', box(100, 800, 900, 830), 0.94)
  const sameAsText = blk('text', box(101, 801, 899, 829), 0.57)
  const other = blk('text', box(100, 900, 900, 960))
  const deduped = dropDuplicates([sameAsText, caption, other])
  check('the same region is not read twice', deduped.length === 2, deduped.map((b) => b.label))
  check(
    '…and the more specific label is the one kept',
    deduped.some((b) => b.label === 'figure_title') &&
      !deduped.some((b) => b.box[1] === 801),
    deduped.map((b) => b.label),
  )

  // The bug this pins: an inline formula sits ENTIRELY inside its
  // paragraph, so "how much of the smaller box is covered" is 1.0 for a
  // pair that is not the same region at all. Deduplicating on that number
  // deleted the paragraphs — a dense page came back as eighteen formulas
  // and three sentences.
  const bigPara = blk('text', box(100, 100, 1100, 400), 0.98)
  const insideFormula = blk('formula', box(300, 250, 400, 290), 0.6)
  const survived = dropDuplicates([bigPara, insideFormula])
  check(
    'a formula inside a paragraph does not delete the paragraph',
    survived.includes(bigPara),
    survived.map((b) => b.label),
  )

  // Inline mathematics belongs to its paragraph: cut out on its own it is a
  // clipped slice of a text line, and the sentence loses its formula.
  const para = blk('text', box(100, 1000, 1100, 1120))
  const inline = blk('formula', box(400, 1040, 700, 1070))
  const display = blk('formula', box(400, 1200, 700, 1260))
  const absorbed = absorbInline([para, inline, display])
  check('an inline formula is left to its paragraph', !absorbed.includes(inline))
  check('…while a display formula stays its own block', absorbed.includes(display))
  check('…and the paragraph is untouched', absorbed.includes(para))

  // Reading order: one column is top-to-bottom, two columns are not.
  const single = [
    blk('text', box(100, 300, 1100, 400)),
    blk('text', box(100, 100, 1100, 200)),
  ]
  check(
    'one column reads top to bottom',
    readingOrder(single, 1200)[0].box[1] === 100,
  )

  const twoCol = [
    blk('text', box(60, 400, 560, 500)),   // left, lower
    blk('text', box(60, 100, 560, 200)),   // left, upper
    blk('text', box(640, 100, 1140, 200)), // right, upper
    blk('text', box(640, 400, 1140, 500)), // right, lower
  ]
  const order = readingOrder(twoCol, 1200).map((b) => `${b.box[0]}:${b.box[1]}`)
  check(
    'two columns read down the left, then down the right',
    order.join(' ') === '60:100 60:400 640:100 640:400',
    order,
  )

  // A full-width figure cuts the page into bands: everything above it is
  // read before it, everything below after.
  const banded = [
    blk('text', box(60, 100, 560, 200)),
    blk('text', box(640, 100, 1140, 200)),
    blk('image', box(60, 300, 1140, 600)),
    blk('text', box(60, 700, 560, 800)),
    blk('text', box(640, 700, 1140, 800)),
  ]
  const withBands = readingOrder(banded, 1200).map((b) => b.label + b.box[1])
  check(
    'a full-width figure separates the bands around it',
    withBands.join(' ') === 'text100 text100 image300 text700 text700',
    withBands,
  )
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL OCR CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

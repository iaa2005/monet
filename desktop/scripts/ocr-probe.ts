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

const {
  OCR_MODELS,
  ALL_MODELS,
  ocrModel,
  ocrVariant,
  variantFiles,
  formatBytes,
  CONFIG_FILES,
} = await import('../src/main/ocr/catalog.js')
const { planInstall, isInstalledSync, modelDir } = await import(
  '../src/main/ocr/install.js'
)
const { getOcrConfig, setOcrConfig } = await import('../src/main/ocr/settings.js')
const { hasOcrModel } = await import('../src/main/ocr/ready.js')
const { parsePages } = await import('../src/main/ocr/tools.js')
const { paddleFiles, stopToken } = await import(
  '../src/main/ocr/paddle/manifest.js'
)
const { readPreprocessing, smartResize } = await import(
  '../src/main/ocr/paddle/preprocess.js'
)

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

  // A shelved model is one nobody can PICK, not one the app may replace.
  // This read the enabled list, so a config naming a shelved model came
  // back as the default — and a bench run then printed the shelved
  // model's name above a different model's output, byte for byte
  // identical to the model it had silently used.
  const shelved = ALL_MODELS.find((m) => !m.enabled)
  if (shelved) {
    setOcrConfig({ modelId: shelved.id })
    check(
      'a shelved model stays selected rather than being swapped out',
      getOcrConfig().modelId === shelved.id,
      { asked: shelved.id, got: getOcrConfig().modelId },
    )
  }

  // Every dtype the catalogue can name has to survive a round trip. This
  // accepted only the two float ones, so a model shipped at q8 was loaded
  // as q4 — a file that does not exist, and the failure named the model
  // rather than the setting that mangled it.
  for (const dtype of ['q4', 'q8', 'fp16', 'fp32'] as const) {
    setOcrConfig({ dtype })
    check(`a ${dtype} setting survives being saved`, getOcrConfig().dtype === dtype, {
      asked: dtype,
      got: getOcrConfig().dtype,
    })
  }

  setOcrConfig({ modelId: cfg.modelId, dtype: cfg.dtype })
}

// ─── PaddleOCR-VL: its own file names, its own runtime ──────────────────

{
  const paddle = ALL_MODELS.find((m) => m.id === 'paddleocr-vl')!
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

  // The runtime opens the graphs by name and the installer downloads them
  // by name, from two different pieces of code. They were once allowed to
  // disagree — the runtime had q4 spelled into it — and the symptom of a
  // model shipped at another precision was a missing file at load, long
  // after the download said it had finished.
  for (const variant of paddle.variants) {
    const installed = variantFiles(paddle, variant.dtype).required
    const opened = paddleFiles(variant.dtype)
    check(
      `the runtime opens the ${variant.dtype} files the installer fetched`,
      installed.join() === [opened.vision, opened.decoder, opened.embedding].join(),
      { installed, opened },
    )
  }
}

// ─── The numbers a build is configured with, not the ones in the port ───

{
  // The crop that found this: one line of text, 944×77, from a real page.
  // The model's own processor makes it 1204 wide. The port made it 1120,
  // because it used the Python CLASS's default min_pixels (130 blocks)
  // rather than the config's (144) — and normalised with CLIP's mean and
  // standard deviation rather than the 0.5/0.5 the config asks for.
  // Neither failed. The model read Russian as fluent nonsense and was
  // written off as bad at Russian.
  const configured = readPreprocessing({
    min_pixels: 112896,
    max_pixels: 1003520,
    image_mean: [0.5, 0.5, 0.5],
    image_std: [0.5, 0.5, 0.5],
  })
  const fitted = smartResize(944, 77, configured)
  check(
    'a line of text is sized the way the model expects',
    fitted.width === 1204 && fitted.height === 112,
    fitted,
  )
  check(
    'the config wins over the defaults compiled into the port',
    configured.minPixels === 112896 && configured.mean[0] === 0.5,
    configured,
  )
  check(
    'a build that ships no processor config still gets sane numbers',
    readPreprocessing({}).mean.join() === '0.5,0.5,0.5' &&
      readPreprocessing({}).minPixels === 28 * 28 * 144,
    readPreprocessing({}),
  )
}

// ─── Where the stop token lives ─────────────────────────────────────────

{
  // Throwing is one of the answers under test, so every call goes through
  // this — otherwise a regression takes the whole probe down with it and
  // the remaining checks never report.
  const eosOf = (
    config: Record<string, number>,
    generation: Record<string, number>,
  ): number | 'threw' => {
    try {
      return stopToken(config, generation)
    } catch {
      return 'threw'
    }
  }

  check(
    'the stop token is read from config.json when it is there',
    eosOf({ eos_token_id: 2 }, {}) === 2,
  )
  check(
    '…and from the generation config when it is not — 1.6 moved it',
    eosOf({ hidden_size: 1024 }, { eos_token_id: 2 }) === 2,
  )
  check(
    '…and a build with neither is refused rather than left to loop',
    eosOf({}, {}) === 'threw',
  )
}

// ─── Shelving a model ───────────────────────────────────────────────────

{
  // A shelved entry keeps everything that was learned about the model and
  // simply stops being offered. Deleting the file would delete the reason.
  const shelved = ALL_MODELS.filter((m) => !m.enabled)
  check('at least one model is shelved rather than deleted', shelved.length > 0, shelved.map((m) => m.id))
  check(
    'a shelved model is not offered',
    !OCR_MODELS.some((m) => !m.enabled) && OCR_MODELS.length < ALL_MODELS.length,
    { offered: OCR_MODELS.map((m) => m.id), all: ALL_MODELS.map((m) => m.id) },
  )
  check(
    '…but still resolves by id, so a config naming it gets a real answer',
    !!ocrModel(shelved[0].id),
  )
  check('every offered model is enabled', OCR_MODELS.every((m) => m.enabled))
  check(
    'and every entry says which runtime it needs',
    ALL_MODELS.every((m) => m.engine === 'transformers' || m.engine === 'paddle'),
  )
  check('ids are unique', new Set(ALL_MODELS.map((m) => m.id)).size === ALL_MODELS.length)
  check(
    'every model names its weight files',
    ALL_MODELS.every((m) => m.variants.length > 0 && m.components.length > 0),
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

// ─── The label list is the model's, not ours ────────────────────────────

{
  const { LAYOUT_LABELS } = await import('../src/main/ocr/layout.js')
  // The model publishes twenty classes. The first version of this list had
  // eighteen, and the two it missed came back as "class18" — read as body
  // text, never absorbed, never dropped. Marginalia spliced into a
  // sentence is exactly the failure that produces.
  check('every class the model can emit has a name', LAYOUT_LABELS.length === 20, LAYOUT_LABELS.length)
  check('…including the ones added after the fact',
    LAYOUT_LABELS.includes('aside_text') && LAYOUT_LABELS.includes('reference_content'))
  check(
    'and the order is the one the model was exported with',
    LAYOUT_LABELS[0] === 'paragraph_title' && LAYOUT_LABELS[7] === 'formula',
  )
}

// ─── Which way up ───────────────────────────────────────────────────────

{
  const { layoutConfidence, prefersRotated, rotate180, rotateBox180, rotateSquare, bestAngle } =
    await import('../src/main/ocr/orientation.js')

  // A page fed in upside down reads BACKWARDS, not badly: the reading model
  // transcribes rotated text fine, so the failure is the last paragraph
  // arriving first — which looks like a bug in the app, not the scan.
  const upright = [
    { label: 'text', score: 0.98, box: [0, 0, 10, 10] as [number, number, number, number] },
    { label: 'text', score: 0.93, box: [0, 20, 10, 30] as [number, number, number, number] },
  ]
  const weak = [
    { label: 'text', score: 0.55, box: [0, 0, 10, 10] as [number, number, number, number] },
  ]
  check('confidence adds up the blocks', Math.abs(layoutConfidence(upright) - 1.91) < 1e-9)
  check('a clearly better rotation wins', prefersRotated(layoutConfidence(weak), layoutConfidence(upright)))
  check(
    '…and a close call does not flip the page',
    !prefersRotated(1.9, 2.0),
  )
  check('nor does an equal one', !prefersRotated(1.0, 1.0))

  // Rotating twice is identity — the mapping has to be exact, or the crops
  // come from the wrong part of the page.
  const box: [number, number, number, number] = [10, 20, 30, 60]
  const there = rotateBox180(box, 100, 200)
  const back = rotateBox180(there, 100, 200)
  check('a box maps back to itself', back.join() === box.join(), { there, back })
  check('…and lands where the page turned it', there.join() === '70,140,90,180', there)

  // Same for pixels: 2×1 image, two colours.
  const rgb = new Uint8Array([1, 2, 3, 4, 5, 6])
  const turned = rotate180(rgb, 2, 1)
  check('pixels come back reversed', Array.from(turned).join() === '4,5,6,1,2,3', Array.from(turned))
  check(
    '…and turning twice is the original',
    Array.from(rotate180(turned, 2, 1)).join() === '1,2,3,4,5,6',
  )

  // A sideways page needs all four angles, not just the flip. The
  // detector's input is square, so testing them costs a pixel loop.
  const square = new Uint8Array([
    1, 1, 1,  2, 2, 2,
    3, 3, 3,  4, 4, 4,
  ])
  const cw = rotateSquare(square, 2, 90)
  // Clockwise: top-left goes to top-right.
  check('90° puts the corner where it belongs', cw[3] === 1 && cw[0] === 3, Array.from(cw))
  check(
    'four 90° turns are the identity',
    Array.from(
      rotateSquare(rotateSquare(rotateSquare(cw, 2, 90), 2, 90), 2, 90),
    ).join() === Array.from(square).join(),
  )
  check(
    '270° undoes 90°',
    Array.from(rotateSquare(cw, 2, 270)).join() === Array.from(square).join(),
  )
  check('0° is a no-op', rotateSquare(square, 2, 0) === square)

  // Choosing the angle: upright wins unless another is clearly better,
  // because turning a page that did not need it is the worse failure.
  check(
    'a clearly sideways page is turned',
    bestAngle([
      { angle: 0, confidence: 1.0 },
      { angle: 90, confidence: 5.0 },
      { angle: 180, confidence: 1.1 },
      { angle: 270, confidence: 0.9 },
    ]) === 90,
  )
  check(
    'an upright page is left alone',
    bestAngle([
      { angle: 0, confidence: 5.0 },
      { angle: 90, confidence: 1.0 },
      { angle: 180, confidence: 4.9 },
      { angle: 270, confidence: 1.0 },
    ]) === 0,
  )
  check(
    'a marginal difference is not enough to turn a page',
    bestAngle([
      { angle: 0, confidence: 4.0 },
      { angle: 180, confidence: 4.4 },
    ]) === 0,
  )
}

// ─── Geometry the detector needs and OpenCV usually provides ───────────

{
  const { connectedComponents, convexHull, minAreaRect, unclip, pageSkew, boundingBox, normaliseAngle } =
    await import('../src/main/ocr/lines/geometry.js')

  // Two separate islands, touching only at a corner: four-connected, so
  // they must stay two. Diagonal joining merges adjacent lines of text.
  const w = 5, h = 5
  const mask = new Uint8Array(w * h)
  const on = (x: number, y: number) => { mask[y * w + x] = 1 }
  // The two islands TOUCH AT A CORNER: (1,1) and (2,2). Eight-connected
  // fill merges them, which in a document means two lines of text becoming
  // one crooked region.
  on(0, 0); on(1, 0); on(1, 1)
  on(2, 2); on(3, 2); on(3, 3)
  const parts = connectedComponents(mask, w, h, 1)
  check('two islands stay two', parts.length === 2, parts.map((p) => p.length))
  check('and every pixel is accounted for', parts[0].length + parts[1].length === 6)
  check('specks below the floor are dropped', connectedComponents(mask, w, h, 4).length === 0)

  // A hull of a filled square is its corners.
  const square: [number, number][] = []
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) square.push([x, y])
  check('a filled square hulls to four corners', convexHull(square).length === 4, convexHull(square).length)

  // An upright rectangle has angle 0 and its own corners.
  const rect = minAreaRect([[0, 0], [10, 0], [10, 4], [0, 4]])
  check('an upright box is not rotated', Math.abs(rect.angle) < 1e-6, rect.angle)
  check('…and keeps its area', Math.abs(boundingBox(rect.quad)[2] - 10) < 1.01, boundingBox(rect.quad))

  // A line of text at 30° must come back at 30°, not as the upright box
  // around it — that box is most of the surrounding paragraph.
  const slanted: [number, number][] = []
  for (let t = 0; t <= 100; t++) {
    const x = t * Math.cos(Math.PI / 6)
    const y = t * Math.sin(Math.PI / 6)
    slanted.push([x, y], [x - 2 * Math.sin(Math.PI / 6), y + 2 * Math.cos(Math.PI / 6)])
  }
  const tilted = minAreaRect(slanted)
  check('a slanted line reports its slant', Math.abs(Math.abs(tilted.angle) - 30) < 2, tilted.angle)

  check('angles are folded into a half turn', normaliseAngle(Math.PI) === 0 && Math.abs(normaliseAngle(Math.PI * 0.75) - -45) < 1e-9)

  // Unclip grows the shape: the detector predicts a SHRUNK region, so
  // without this every crop clips its own letters.
  const tight = minAreaRect([[10, 10], [30, 10], [30, 20], [10, 20]]).quad
  const grown = unclip(tight, 1.5)
  const before = boundingBox(tight)
  const after = boundingBox(grown)
  check('unclip grows the quad', after[0] < before[0] && after[2] > before[2], { before, after })

  // Page skew is the MEDIAN, so one caption at an angle cannot tilt a page.
  const lines = [
    { quad: [[0, 0], [100, 0], [100, 10], [0, 10]], angle: 0.4 },
    { quad: [[0, 0], [100, 0], [100, 10], [0, 10]], angle: 0.6 },
    { quad: [[0, 0], [100, 0], [100, 10], [0, 10]], angle: 0.5 },
    { quad: [[0, 0], [100, 0], [100, 10], [0, 10]], angle: 42 },
  ] as never
  check('one crooked caption does not tilt the page', Math.abs(pageSkew(lines) - 0.55) < 0.2, pageSkew(lines))
}

// ─── Straightening a crooked scan ───────────────────────────────────────

{
  const { detInputSize, worthDeskewing } = await import(
    '../src/main/ocr/lines/detect.js'
  )

  // The detector's own resize rule: long side 960, both sides a multiple
  // of 32. A side that is not a multiple of 32 is a shape error deep in
  // the graph, not a slightly different result.
  const a4 = detInputSize(2480, 3508)
  check('the long side is capped', Math.max(a4.width, a4.height) <= 960, a4)
  check('both sides land on the grid', a4.width % 32 === 0 && a4.height % 32 === 0, a4)
  check('the aspect is roughly kept', Math.abs(a4.width / a4.height - 2480 / 3508) < 0.05, a4)
  const small = detInputSize(100, 40)
  check('a small picture is not blown up', small.width <= 128, small)
  check('…and never smaller than one tile', small.width >= 32 && small.height >= 32, small)

  // Straightening is worth it in a band: below a degree it costs a
  // resample and buys nothing, above fifteen the median is measuring
  // something other than body text and a right angle was the answer.
  check('a level page is left alone', !worthDeskewing(0.4))
  check('a three-degree tilt is straightened', worthDeskewing(3) && worthDeskewing(-3))
  check('a wildly wrong angle is not a skew', !worthDeskewing(47))
  check('and the sign does not matter', worthDeskewing(-12) === worthDeskewing(12))
}

// ─── Runaway generations ────────────────────────────────────────────────

{
  const { trimLoop } = await import('../src/main/ocr/loops.js')
  const NL = String.fromCharCode(10)

  const ok = ['Первая строка', 'вторая строка', 'третья'].join(NL)
  check('ordinary text is left alone', trimLoop(ok).text === ok && !trimLoop(ok).looped)

  // A table legitimately repeats a value; four in a row must survive.
  const table = ['| a | 0.02 |', '| b | 0.02 |', '| c | 0.02 |'].join(NL)
  check('a table with repeated values is not a loop', !trimLoop(table).looped, trimLoop(table))

  // What Qwen3-VL actually did.
  const loop = ['начало', ...new Array(20).fill('| Кубитовая | 0.02 |')].join(NL)
  const cut = trimLoop(loop)
  check('a runaway repetition is cut', cut.looped)
  check('…and what came before it is kept', cut.text.startsWith('начало'), cut.text.slice(0, 40))
  check('…leaving at most a few copies', cut.text.split(NL).length <= 5, cut.text.split(NL).length)

  // SmolDocling's failure: the same line over and over, nothing else.
  const царнир = new Array(50).fill('<text>Царнир</text>').join(NL)
  check('a page of one repeated line collapses', trimLoop(царнир).text.split(NL).length <= 5)

  // Two lines alternating is the same disease with a longer period.
  const pair = new Array(12).fill(['раз', 'два']).flat().join(NL)
  check('an alternating pair is caught too', trimLoop(pair).looped, trimLoop(pair).text.split(NL).length)
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

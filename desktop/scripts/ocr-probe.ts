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

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL OCR CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

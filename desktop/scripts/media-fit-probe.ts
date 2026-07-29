/**
 * Checks the image-fitting arithmetic.
 *
 * This is where an off-by-a-factor hides: a coordinate the model reads off a
 * downsampled copy is wrong by exactly the scale factor, so the delivery note
 * has to state the ORIGINAL size every time, and the refusal path has to fire
 * rather than send something the provider will reject.
 */

import {
  clampRegion,
  describeDelivery,
  MAX_EDGE_PX,
  planFit,
  READ_BYTE_BUDGET,
  scaledSize,
  scaleToFit,
} from '../src/main/agent/media-fit.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Scaling ────────────────────────────────────────────────────────────

check('a small image is not scaled', scaleToFit({ width: 800, height: 600 }, 2000) === 1)
check('an image never upscales', scaleToFit({ width: 10, height: 10 }, 2000) === 1)
check(
  'the LONGEST edge decides',
  scaleToFit({ width: 400, height: 4000 }, 2000) === 0.5,
  scaleToFit({ width: 400, height: 4000 }, 2000),
)
check(
  'aspect ratio survives scaling',
  ((): boolean => {
    const s = scaledSize({ width: 4000, height: 3000 }, 0.5)
    return s.width === 2000 && s.height === 1500
  })(),
)
check(
  'a scaled dimension never rounds to zero',
  scaledSize({ width: 3000, height: 1 }, 0.001).height === 1,
)

// ─── Region clamping ────────────────────────────────────────────────────

const size = { width: 1000, height: 800 }
check(
  'a region inside the image is untouched',
  JSON.stringify(clampRegion({ x: 10, y: 20, width: 100, height: 50 }, size)) ===
    JSON.stringify({ x: 10, y: 20, width: 100, height: 50 }),
)
check(
  'a region running off the right edge is trimmed',
  clampRegion({ x: 900, y: 0, width: 500, height: 50 }, size)?.width === 100,
  clampRegion({ x: 900, y: 0, width: 500, height: 50 }, size),
)
check(
  'a negative origin is pulled back to 0',
  clampRegion({ x: -50, y: -50, width: 100, height: 100 }, size)?.x === 0,
)
check(
  'a region entirely off the image is rejected',
  clampRegion({ x: 5000, y: 5000, width: 10, height: 10 }, size) === null,
)

// ─── Plans ──────────────────────────────────────────────────────────────

const small = { bytes: 50_000, size: { width: 800, height: 600 } }
check('a small image goes as-is', planFit(small).kind === 'as-is', planFit(small))

const huge = { bytes: 9_000_000, size: { width: 6000, height: 4000 } }
const hugePlan = planFit(huge)
check('a huge image is downsampled', hugePlan.kind === 'downsample', hugePlan)
check(
  'and lands within the pixel ceiling',
  hugePlan.kind === 'downsample' &&
    Math.max(hugePlan.to.width, hugePlan.to.height) <= MAX_EDGE_PX,
  hugePlan,
)

// Small in pixels but heavy in bytes — a dense photo. Must still be re-encoded.
const dense = planFit({ bytes: 900_000, size: { width: 1200, height: 900 } })
check('a dense small image is still re-encoded', dense.kind === 'downsample', dense)

const cropped = planFit({ ...huge, region: { x: 10, y: 10, width: 100, height: 100 } })
check('a region request becomes a crop', cropped.kind === 'crop', cropped)
check(
  'and a crop is NOT downsampled — that is the point of asking',
  cropped.kind === 'crop',
)

const badRegion = planFit({ ...huge, region: { x: 99_999, y: 0, width: 10, height: 10 } })
check('an off-image region is refused', badRegion.kind === 'refuse', badRegion)
check(
  'and the refusal says coordinates are in the original space',
  badRegion.kind === 'refuse' && /ORIGINAL/.test(badRegion.message),
)

// full_resolution is honoured only when it can be.
const fullOk = planFit({ bytes: 100_000, size: { width: 3000, height: 2000 }, fullResolution: true })
check('full_resolution on a light file is honoured', fullOk.kind === 'as-is', fullOk)
const fullNo = planFit({ ...huge, fullResolution: true })
check('full_resolution on a heavy file is refused', fullNo.kind === 'refuse', fullNo)
check(
  'and the refusal suggests a region instead',
  fullNo.kind === 'refuse' && /region/i.test(fullNo.message),
)

// ─── The delivery note ──────────────────────────────────────────────────

const note = describeDelivery({
  path: 'chart.png',
  mediaType: 'image/png',
  bytes: 9_000_000,
  original: { width: 6000, height: 4000 },
  plan: hugePlan,
  delivered: { width: 2000, height: 1333 },
})
check('the note states the ORIGINAL size', note.includes('6000x4000'), note)
check('the note states what was delivered', note.includes('2000x1333'))
check('the note warns not to measure off the copy', /never measure off this copy/i.test(note))
check('the note points at region and full_resolution', /region/.test(note) && /full_resolution/.test(note))

const cropNote = describeDelivery({
  path: 'ui.png',
  mediaType: 'image/png',
  bytes: 1000,
  original: { width: 1000, height: 800 },
  plan: { kind: 'crop', region: { x: 40, y: 60, width: 100, height: 100 } },
})
check('a crop note gives the offset to add back', cropNote.includes('40,60'), cropNote)

const asIsNote = describeDelivery({
  path: 'a.png',
  mediaType: 'image/png',
  bytes: 1000,
  original: { width: 10, height: 10 },
  plan: { kind: 'as-is', reason: 'within-limits' },
})
check('an untouched image says so', /untouched/i.test(asIsNote), asIsNote)
check('every note is wrapped in a system tag', asIsNote.startsWith('<system>') && asIsNote.endsWith('</system>'))

check('the byte budget is a sane number', READ_BYTE_BUDGET > 64 * 1024)

console.log(failures === 0 ? '\nALL MEDIA-FIT CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Does "build a voice from your recording" actually work?
 *
 * The claim is testable without a human: synthesise a KNOWN voice, hand that
 * audio to the fit as if it were a recording, and see whether the search finds
 * its way back. If it cannot recover Daniel from Daniel's own speech, it has no
 * chance with a person — and if it can, the machinery (embedder, resampler,
 * inline styles, the search itself) is sound end to end and only the ceiling is
 * in question.
 *
 * Runs the real models, in the real data dir: the 398 MB voice must already be
 * installed (Settings → Voice) and the 29 MB matcher is downloaded here if
 * missing. Takes a couple of minutes — about sixty real syntheses.
 *
 *   npm run smoke:voicefit
 */

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { setDataDir } from '../src/main/data-dir.js'

const real = [resolve('..', '.monet-prod'), resolve('..', '.monet')].find((d) =>
  existsSync(join(d, 'tts-models', 'supertonic-3', 'vocoder.onnx')),
)
if (!real) {
  console.log('SKIP  the 398 MB voice model is not installed — nothing to fit with')
  process.exit(0)
}
setDataDir(real)

const { speak, ttsNativeAvailable } = await import('../src/main/tts/engine.js')
const { fitVoice } = await import('../src/main/tts/voice-fit.js')
const {
  embed,
  cosine,
  installSpeakerModel,
  speakerModelInstalled,
  disposeEmbedder,
  SPEAKER_BYTES,
} = await import('../src/main/tts/speaker.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// The engine forks its children from beside its own bundle.
const builtChildren = ['out/main/supertonic-child.js', 'out/main/embed-child.js']
if (!builtChildren.every((f) => existsSync(resolve(f)))) {
  console.log('SKIP  run `npm run build` first')
  process.exit(0)
}
const copyWithChunks = (from: string, toDir: string): void => {
  mkdirSync(toDir, { recursive: true })
  copyFileSync(from, join(toDir, basename(from)))
  const src = readFileSync(from, 'utf8')
  for (const m of src.matchAll(/from ["'](\.\/chunks\/[^"']+)["']/g)) {
    const rel = m[1].slice(2)
    const chunk = resolve('out/main', rel)
    if (existsSync(chunk) && !existsSync(join(toDir, 'chunks', basename(rel))))
      copyWithChunks(chunk, join(toDir, 'chunks'))
  }
}
for (const f of builtChildren) {
  copyWithChunks(resolve(f), resolve('out-smoke'))
  copyWithChunks(resolve(f), resolve('out-smoke/assets'))
}

if (!ttsNativeAvailable()) {
  console.log('SKIP  onnxruntime-node is not installed')
  process.exit(0)
}

// ─── The matcher ────────────────────────────────────────────────────────

if (!(await speakerModelInstalled())) {
  console.log(`      downloading the voice matcher (${(SPEAKER_BYTES / 1e6).toFixed(0)} MB)…`)
  const r = await installSpeakerModel((p) => {
    if (p.percent % 25 === 0 && !p.done) console.log(`      ${p.percent}%`)
  })
  check('the matcher downloads and checksums', r.ok, r.error)
}
check('and reports itself installed', await speakerModelInstalled())

// A speaker embedding has to behave like one before anything built on it can:
// the same voice twice must be closer than two different voices.
const say = async (voice: string): Promise<Float32Array> => {
  const r = await speak({ text: 'Проверяю, как звучит этот голос на длинной фразе с обычными словами.', voice, lang: 'ru', steps: 4 })
  if (!r.ok || !r.samplesBase64) throw new Error(r.error ?? 'no audio')
  const b = Buffer.from(r.samplesBase64, 'base64')
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4)
}

const danielA = await say('M5')
const danielB = await say('M5')
const sarah = await say('F1')
const eA = await embed(danielA, 44_100)
const eB = await embed(danielB, 44_100)
const eS = await embed(sarah, 44_100)
check('the embedder answers with a vector', !!eA && eA.length > 100, eA?.length)
if (eA && eB && eS) {
  const same = cosine(eA, eB)
  const other = cosine(eA, eS)
  check('THE SAME VOICE IS CLOSER TO ITSELF THAN TO ANOTHER', same > other + 0.1, {
    danielVsDaniel: +same.toFixed(3),
    danielVsSarah: +other.toFixed(3),
  })
  check('and identity is not a free 1.0 for everything', other < 0.95, +other.toFixed(3))
}

// ─── Refusals ───────────────────────────────────────────────────────────

const tooShort = await fitVoice({ samples: new Float32Array(8_000), sampleRate: 16_000 })
check('a one-second clip is refused with a reason', !tooShort.ok && /at least/.test(tooShort.error ?? ''), tooShort)

const cancelled = await fitVoice({
  samples: danielA,
  sampleRate: 44_100,
  cancelled: () => true,
})
check('a cancelled search stops instead of finishing', !cancelled.ok && /Cancel/i.test(cancelled.error ?? ''), cancelled)

// ─── The real thing ─────────────────────────────────────────────────────

console.log('      searching (about sixty syntheses)…')
const t0 = Date.now()
let last = 0
const fitted = await fitVoice({
  samples: danielA,
  sampleRate: 44_100,
  lang: 'ru',
  onProgress: (p) => {
    if (p.step - last >= 10) {
      last = p.step
      console.log(`      ${p.step}/${p.total} · best ${(p.best * 100).toFixed(0)}%`)
    }
  },
})
const mins = ((Date.now() - t0) / 60_000).toFixed(1)
check('the search finishes', fitted.ok, fitted.error)
if (fitted.ok && fitted.parts) {
  console.log(`      ${mins} min · ${fitted.parts.map((p) => `${p.id}:${p.weight.toFixed(2)}`).join(' ')}`)
  check(
    'IT RECOVERS THE VOICE IT WAS GIVEN — Daniel from Daniel',
    (fitted.score ?? 0) > 0.8,
    { score: +(fitted.score ?? 0).toFixed(3), base: +(fitted.baseScore ?? 0).toFixed(3) },
  )
  const heaviest = [...fitted.parts].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0]
  check('and it leans on the right one', heaviest?.id === 'M5', fitted.parts)
  check(
    'the search does not make things worse than the best single voice',
    (fitted.score ?? 0) >= (fitted.baseScore ?? 0) - 1e-9,
    { score: fitted.score, base: fitted.baseScore },
  )
  // The blender normalises by the sum of what it receives, so the fit must hand
  // over the WHOLE blend: prune the tail and the saved voice is not the one that
  // was scored. (Caught here — the first version filtered at 0.02.)
  check(
    'THE WEIGHTS IT RETURNS ARE THE BLEND IT SCORED — nothing pruned',
    Math.abs(fitted.parts.reduce((n, p) => n + Math.abs(p.weight), 0) - 1) < 1e-6 &&
      fitted.parts.every((p) => Math.abs(p.weight) <= 1),
    { sum: fitted.parts.reduce((n, p) => n + Math.abs(p.weight), 0), parts: fitted.parts },
  )
}

disposeEmbedder()
console.log(failures === 0 ? '\nit finds its way back' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

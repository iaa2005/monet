/**
 * The on-device voice, up to the edge of the synthesiser.
 *
 * Pins the catalogue (URLs, sizes, hashes — a wrong one is a corrupt 400 MB
 * download that kills the child with no message), the install arithmetic
 * (part-files and wrong sizes never count as installed), and the tag
 * discipline: what the UI hides, what the synthesiser hears.
 *
 * With the model already on disk it also runs the real child once.
 *
 *   npm run smoke:tts
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'tts-probe-'))
setDataDir(tempData)

const {
  TTS_MODEL_FILES,
  TTS_VOICES,
  DEFAULT_TTS_VOICE,
  ttsFileUrl,
  ttsFileName,
  ttsModelBytes,
  voiceFile,
  stripTtsTags,
  textForSpeech,
} = await import('../src/main/tts/catalog.js')
const { ttsStatus, ttsNativeAvailable, speak } = await import('../src/main/tts/engine.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Catalogue ──────────────────────────────────────────────────────────

check(
  'every URL is an https resolve link and every name is flat',
  TTS_MODEL_FILES.every(
    (f) =>
      /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/main\//.test(ttsFileUrl(f)) &&
      !ttsFileName(f).includes('/'),
  ),
)
check(
  'the big networks carry hashes, the small JSONs carry sizes',
  TTS_MODEL_FILES.every((f) => (f.bytes > 1_000_000 ? !!f.sha256 : true)),
)
check('the whole model is ~398 MB', Math.abs(ttsModelBytes() - 398_361_202) < 1_000_000, ttsModelBytes())
// Ten, not the README's eleven: F6 exists only in supertonic-2's styles.
check('ten voices, unique ids', new Set(TTS_VOICES.map((v) => v.id)).size === 10 && TTS_VOICES.length === 10)
check('the default voice exists', !!voiceFile(DEFAULT_TTS_VOICE))
check('an unknown voice is null, not a crash', voiceFile('X9') === null)

// ─── Tags ───────────────────────────────────────────────────────────────

check(
  'the UI never shows a tag',
  stripTtsTags('Готово! <laugh> Всё зелёное. <breath> Коммитим?') === 'Готово! Всё зелёное. Коммитим?',
  stripTtsTags('Готово! <laugh> Всё зелёное. <breath> Коммитим?'),
)
check(
  'the voice keeps known tags and loses invented ones',
  textForSpeech('Так. <laugh> Тихо: <whisper>секрет</whisper>. <sigh> Всё.') ===
    'Так. <laugh> Тихо: секрет. <sigh> Всё.',
  textForSpeech('Так. <laugh> Тихо: <whisper>секрет</whisper>. <sigh> Всё.'),
)
check(
  'markdown comparisons survive the stripper',
  stripTtsTags('a < b и x <= y, а <code> не тег речи') === 'a < b и x <= y, а <code> не тег речи',
)

// ─── Install state ──────────────────────────────────────────────────────

let st = await ttsStatus()
check('a fresh data dir has nothing installed', !st.installed && st.voices.every((v) => !v.installed))

const dir = join(tempData, 'tts-models', 'supertonic-3')
mkdirSync(dir, { recursive: true })
for (const f of TTS_MODEL_FILES) writeFileSync(join(dir, ttsFileName(f)), Buffer.alloc(f.bytes > 10_000_000 ? 0 : f.bytes))
st = await ttsStatus()
check('right names with wrong sizes still do not count as installed', !st.installed)
for (const f of TTS_MODEL_FILES) writeFileSync(join(dir, ttsFileName(f)), Buffer.alloc(f.bytes))
writeFileSync(join(dir, 'F1.json'), Buffer.alloc(292_046))
st = await ttsStatus()
check('exact sizes count as installed', st.installed)
check('and the voice that is present reports installed', st.voices.find((v) => v.id === 'F1')?.installed === true)
check('while an absent voice does not', st.voices.find((v) => v.id === 'M5')?.installed === false)

// ─── The real synthesiser, when the model is on disk ────────────────────

const realDirs = [
  resolve('..', '.monet-prod', 'tts-models', 'supertonic-3'),
  resolve('..', '.monet', 'tts-models', 'supertonic-3'),
]
const realDir = realDirs.find((d) => existsSync(join(d, 'vocoder.onnx')))
if (!ttsNativeAvailable()) {
  console.log('SKIP  synthesis (onnxruntime-node not installed)')
} else if (!realDir) {
  console.log('SKIP  synthesis (model not downloaded — install it in Settings to cover this)')
} else {
  setDataDir(resolve(realDir, '..', '..'))
  const builtChild = resolve('out/main/supertonic-child.js')
  if (!existsSync(builtChild)) {
    console.log('SKIP  synthesis (run `npm run build` first)')
  } else {
    // The engine forks the child from beside its own bundle (out-smoke here).
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
    copyWithChunks(builtChild, resolve('out-smoke'))
    copyWithChunks(builtChild, resolve('out-smoke/assets'))
    const t0 = Date.now()
    const r = await speak({ text: 'Проба голоса. <breath> Всё работает.', voice: 'F1', lang: 'ru', steps: 4 })
    const ms = Date.now() - t0
    check('the child speaks Russian', r.ok && !!r.samplesBase64, r.error)
    const seconds = r.samplesBase64 ? Buffer.from(r.samplesBase64, 'base64').length / 4 / (r.sampleRate ?? 44100) : 0
    check('a plausible amount of audio came back', seconds > 1 && seconds < 10, { seconds, ms })
    console.log(`      ${seconds.toFixed(1)}s audio in ${ms}ms (cold)`)
    const missing = await speak({ text: 'x', voice: 'X9', lang: 'ru' })
    check('an unknown voice fails cleanly', !missing.ok && !!missing.error)
  }
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\ntts probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

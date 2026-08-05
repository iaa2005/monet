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
const { markdownForSpeech } = await import('../src/shared/voice-tags.js')
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
  'the voice doubles known tags and loses invented ones',
  textForSpeech('Так. <laugh> Тихо: <whisper>секрет</whisper>. <sigh> Всё.') ===
    'Так. <laugh><laugh> Тихо: секрет. <sigh><sigh> Всё.',
  textForSpeech('Так. <laugh> Тихо: <whisper>секрет</whisper>. <sigh> Всё.'),
)
check(
  'markdown comparisons survive the stripper',
  stripTtsTags('a < b и x <= y, а <code> не тег речи') === 'a < b и x <= y, а <code> не тег речи',
)
// The live Russian test (2026-08-05) sorted discussion #6's ten tags into
// performed and merely-pronounced; the pronounced ones must never reach
// the synthesiser, the performed ones land reliably only doubled — and
// <scream> only in its interjection-hug shape, never multiplied.
check(
  'vocalised-only tags are dropped, runs collapse to exactly two',
  textForSpeech('Ох. <yawn> Устала. <surprise> Ого! <cough><cough><cough> Кхе.') ===
    'Ох. Устала. Ого! <cough><cough> Кхе.',
  textForSpeech('Ох. <yawn> Устала. <surprise> Ого! <cough><cough><cough> Кхе.'),
)
check(
  'a scream keeps its interjection hug untouched',
  textForSpeech('<scream> Ааа <scream>') === '<scream> Ааа <scream>',
  textForSpeech('<scream> Ааа <scream>'),
)
// Paragraph-initial tags get READ (once), the same pair after a sentence
// performs — so a leading run migrates past the first sentence, and a
// one-sentence chunk carries it at the end.
check(
  'a leading tag run migrates past the first sentence',
  textForSpeech('<breath> Значит, слушай. Дальше больше.') ===
    'Значит, слушай. <breath><breath> Дальше больше.',
  textForSpeech('<breath> Значит, слушай. Дальше больше.'),
)
check(
  'a one-sentence chunk carries the leading run at its end',
  textForSpeech('<sigh><sigh> Опять дедлайн') === 'Опять дедлайн <sigh><sigh>',
  textForSpeech('<sigh><sigh> Опять дедлайн'),
)
check(
  'the UI hides the new tags too',
  stripTtsTags('Ну что <surprise> вышло! <throatclear> Кхм.') === 'Ну что вышло! Кхм.',
  stripTtsTags('Ну что <surprise> вышло! <throatclear> Кхм.'),
)

const md = '**Что я сделала:**\n- создала `app.py`\n- открыла [сайт](https://x.dev)\n# Итог'
check(
  'markdown flattens for the mouth: bold, code, bullets, links',
  markdownForSpeech(md) === 'Что я сделала:\nсоздала app.py\nоткрыла сайт\nИтог',
  markdownForSpeech(md),
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
    // Past ~300 characters the model races — more text, barely more audio.
    // The child must split at sentence ends and rejoin; joined speech comes
    // out at a human rate, so duration scales with length.
    const longText = [
      'Сначала я проверила логи контейнера и нашла настоящую причину падения: в образе не хватало одной зависимости.',
      'Потом я поставила её в общий кеш, пересобрала окружение и прогнала все тесты заново, уже без единой ошибки.',
      'После этого я запустила сервер, открыла страницу в браузере и убедилась, что графики строятся и данные обновляются.',
      'В конце я привела в порядок отчёт, сохранила его рядом с проектом и подготовила короткое резюме для тебя.',
    ].join(' ')
    const t1 = Date.now()
    const rl = await speak({ text: longText, voice: 'F1', lang: 'ru', steps: 4 })
    const lbuf = rl.samplesBase64 ? Buffer.from(rl.samplesBase64, 'base64') : Buffer.alloc(0)
    const lsec = lbuf.length / 4 / (rl.sampleRate ?? 44100)
    // The joins are audible in the DATA: the child separates pieces with
    // ~120 ms of literal zero samples, and a vocoder never emits thousands
    // of exact zeros in a row. No gaps = the text went through whole.
    const lpcm = new Float32Array(lbuf.buffer, lbuf.byteOffset, lbuf.length / 4)
    let gaps = 0
    let run = 0
    for (let i = 0; i < lpcm.length; i++) {
      if (lpcm[i] === 0) {
        run++
        if (run === 2000) gaps++
      } else run = 0
    }
    check(
      'long text is split for the model: silence joins present, human rate',
      rl.ok && gaps >= 1 && lsec > longText.length / 25 && lsec < 90,
      { chars: longText.length, seconds: +lsec.toFixed(1), gaps, error: rl.error },
    )
    console.log(`      ${lsec.toFixed(1)}s audio, ${gaps} join(s), from ${longText.length} chars in ${Date.now() - t1}ms`)
    const missing = await speak({ text: 'x', voice: 'X9', lang: 'ru' })
    check('an unknown voice fails cleanly', !missing.ok && !!missing.error)
  }
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\ntts probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

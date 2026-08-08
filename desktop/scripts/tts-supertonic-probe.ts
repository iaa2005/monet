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
const { ttsStatus, ttsNativeAvailable, speak, forgetVoiceStyle } = await import('../src/main/tts/engine.js')
const {
  checkVoiceStyle,
  importCustomVoice,
  listCustomVoices,
  removeCustomVoice,
  voiceSlug,
} = await import('../src/main/tts/custom-voices.js')
const { isCustomVoice, customVoicePath } = await import('../src/main/tts/paths.js')
const { readStyleFile, styleMapOf } = await import('../src/main/tts/style-map.js')
const { mapCells, styleMap, MAP_SIZE } = await import('../src/shared/voice-map.js')

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
// "Female 1" told the user nothing. The names are Supertone's own.
check(
  'every voice has a name and a line about it, all names distinct',
  TTS_VOICES.every((v) => /^[A-Z][a-z]+$/.test(v.name) && v.desc.length > 15) &&
    new Set(TTS_VOICES.map((v) => v.name)).size === TTS_VOICES.length,
  TTS_VOICES.map((v) => `${v.id}:${v.name}`),
)
// The first letter is load-bearing: a spoken Russian reply agrees with it
// (MessageInput reads voiceGender straight off the id).
check(
  'the id still carries the gender, presets and imports alike',
  TTS_VOICES.every((v) => /^[FM]\d$/.test(v.id)) && isCustomVoice('M-sasha') && !isCustomVoice('M1'),
)
check(
  'and an id that could be a path is not a custom voice',
  !isCustomVoice('../../../etc/passwd') && !isCustomVoice('F-..\\x') && !isCustomVoice('F-'),
)
// The card picture is the voice's own style tensor, precomputed for the
// presets so a voice has a face before it is downloaded.
check(
  'every preset carries a voice map of the right size',
  TTS_VOICES.every((v) => /^[0-9a-f]+$/.test(v.art) && v.art.length === MAP_SIZE * MAP_SIZE),
  TTS_VOICES.map((v) => v.art.length),
)
check(
  'AND NO TWO VOICES LOOK ALIKE',
  new Set(TTS_VOICES.map((v) => v.art)).size === TTS_VOICES.length,
)
check(
  'each map is alive — not a flat field of "same as average"',
  TTS_VOICES.every((v) => {
    const ink = mapCells(v.art).filter((c) => Math.abs(c - 8) > 1).length
    return ink > 40 && ink < 140
  }),
  TTS_VOICES.map((v) => mapCells(v.art).filter((c) => Math.abs(c - 8) > 1).length),
)
check('a malformed map reads as flat rather than throwing', mapCells('nope').every((c) => c === 8))

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
// …but a laugh opens a paragraph just fine — only breath and sigh move.
check(
  'a leading laugh stays where it is',
  textForSpeech('<laugh> Представляешь? Вот так.') === '<laugh><laugh> Представляешь? Вот так.',
  textForSpeech('<laugh> Представляешь? Вот так.'),
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

// ─── A voice of your own ────────────────────────────────────────────────
//
// The whole voice is two style tensors in a JSON. Supertone's builder closes
// on 31 August 2026, so a file already downloaded has to keep working with no
// service behind it — which it does, because nothing here is a service.

const style = (ttl: number[], dp: number[]): string =>
  JSON.stringify({
    style_ttl: { dims: [1, 50, 256], data: ttl, type: 'float32' },
    style_dp: { dims: [1, 8, 16], data: dp, type: 'float32' },
  })
const goodStyle = style(new Array(12_800).fill(0.01), new Array(128).fill(0.02))

check('a real style file passes', checkVoiceStyle(goodStyle).ok)
check(
  'nested data (the builder writes it in rows) passes too',
  checkVoiceStyle(
    JSON.stringify({
      style_ttl: { dims: [1, 50, 256], data: [new Array(50).fill(new Array(256).fill(0.01))] },
      style_dp: { dims: [1, 8, 16], data: [new Array(8).fill(new Array(16).fill(0.02))] },
    }),
  ).ok,
  checkVoiceStyle(
    JSON.stringify({
      style_ttl: { dims: [1, 50, 256], data: [new Array(50).fill(new Array(256).fill(0.01))] },
      style_dp: { dims: [1, 8, 16], data: [new Array(8).fill(new Array(16).fill(0.02))] },
    }),
  ).error,
)
check('a picture is not a voice', !checkVoiceStyle('\x89PNG\r\n').ok)
check('an empty object is not a voice', !checkVoiceStyle('{}').ok)
// The failure that would otherwise happen twenty seconds later, inside
// onnxruntime, with a shape error nobody can act on.
const v2 = checkVoiceStyle(
  JSON.stringify({
    style_ttl: { dims: [1, 1, 192], data: new Array(192).fill(0) },
    style_dp: { dims: [1, 8, 16], data: new Array(128).fill(0) },
  }),
)
check('A SUPERTONIC 2 EMBEDDING IS REFUSED, BY NAME', !v2.ok && /Supertonic 2/.test(v2.error ?? ''), v2)
check(
  'right shape, wrong amount of numbers is refused',
  !checkVoiceStyle(style(new Array(12_799).fill(0), new Array(128).fill(0))).ok,
)
check(
  'and so are values that are not numbers',
  !checkVoiceStyle(
    JSON.stringify({
      style_ttl: { dims: [1, 50, 256], data: new Array(12_800).fill('x') },
      style_dp: { dims: [1, 8, 16], data: new Array(128).fill(0) },
    }),
  ).ok,
)

check('a Cyrillic name still makes a filename', voiceSlug('Марина') === 'марина' && voiceSlug('!!!') === 'voice')

const src = join(tempData, 'my-voice.json')
writeFileSync(src, goodStyle, 'utf-8')
const imported = importCustomVoice({ path: src, name: 'Марина', gender: 'F' })
check('an import lands under a gendered id', imported.ok && imported.id === 'F-марина', imported)
check('a nameless import is refused', !importCustomVoice({ path: src, name: '  ', gender: 'F' }).ok)
const again = importCustomVoice({ path: src, name: 'Марина', gender: 'F' })
check('the same name twice does not overwrite the first', again.ok && again.id === 'F-марина-2', again)
check('both are listed, by name', listCustomVoices().length === 2)

st = await ttsStatus()
const mine = st.voices.find((v) => v.id === 'F-марина')
check('an imported voice joins the picker', !!mine && mine.custom === true && mine.name === 'Марина', mine)
check('and needs no download — it is already here', mine?.installed === true)
check('the presets are still there beside it', st.voices.filter((v) => !v.custom).length === 10)

// Freeing 398 MB must not take a voice that cannot be downloaded again.
await (await import('../src/main/tts/engine.js')).removeTts()
check('REMOVING THE MODEL KEEPS YOUR OWN VOICES', listCustomVoices().length === 2, listCustomVoices())
st = await ttsStatus()
check('…and the model really did go', !st.installed)

removeCustomVoice('F-марина-2')
check('a deleted voice is gone from the list and the disk', listCustomVoices().length === 1)
check(
  'the file went with it',
  !existsSync(join(tempData, 'tts-models', 'custom', 'F-марина-2.json')),
)
removeCustomVoice('F-марина')
check('and the last one leaves nothing behind', listCustomVoices().length === 0)

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
    const goneCustom = await speak({ text: 'x', voice: 'F-nosuch', lang: 'ru' })
    check(
      'and a custom voice whose file is gone says so, rather than "unknown"',
      !goneCustom.ok && /import it again/.test(goneCustom.error ?? ''),
      goneCustom.error,
    )

    // An imported voice, through the real model: a preset's own style file
    // stands in for a builder download — byte for byte the same kind of file.
    // One 0.3 MB file into the live data dir, removed again below.
    const probeImport = importCustomVoice({
      path: join(realDir, 'F1.json'),
      name: 'Probe',
      gender: 'F',
    })
    check('a preset style imports as a voice of your own', probeImport.ok, probeImport)
    if (probeImport.id) {
      const rc = await speak({ text: 'Свой голос работает.', voice: probeImport.id, lang: 'ru', steps: 4 })
      const csec = rc.samplesBase64 ? Buffer.from(rc.samplesBase64, 'base64').length / 4 / (rc.sampleRate ?? 44100) : 0
      check('AN IMPORTED VOICE ACTUALLY SPEAKS', rc.ok && csec > 0.5, { seconds: +csec.toFixed(1), error: rc.error })
      removeCustomVoice(probeImport.id)
      check(
        'and the probe leaves the real data dir as it found it',
        !existsSync(join(realDir, '..', 'custom', `${probeImport.id}.json`)) &&
          !listCustomVoices().some((v) => v.id === probeImport.id),
      )
    }

    // The maps in the catalogue are supposed to BE these files' maps. Nothing
    // else pins that: they are constants, so a change to how a map is computed
    // (or to the baseline it is measured against) would leave ten stale
    // pictures that still look plausible.
    const recomputed = TTS_VOICES.map((v) => ({
      id: v.id,
      same: styleMapOf(join(realDir, `${v.id}.json`)) === v.art,
    }))
    check(
      'THE CATALOGUE MAPS ARE THE REAL FILES\' MAPS',
      recomputed.every((r) => r.same),
      recomputed.filter((r) => !r.same).map((r) => r.id),
    )

    // Reported: "Voice process exited (SIGTERM)" on every Listen. Dropping a
    // cached style used to KILL the child, and the dead child's exit handler
    // failed the request the NEW child was already carrying — the pending map
    // was shared by every child ever forked. A style file rewritten at the same
    // path, twice, with a synthesis after each, is that sequence.
    const reimport = importCustomVoice({ path: join(realDir, 'F1.json'), name: 'Churn', gender: 'F' })
    if (reimport.id) {
      let sigterm = ''
      for (const from of ['M2.json', 'F5.json']) {
        writeFileSync(customVoicePath(reimport.id), readFileSync(join(realDir, from), 'utf-8'), 'utf-8')
        forgetVoiceStyle(reimport.id)
        const r = await speak({ text: 'Проба.', voice: reimport.id, lang: 'ru', steps: 4 })
        if (!r.ok) sigterm = r.error ?? 'failed'
      }
      check('A RESTYLED VOICE DOES NOT KILL THE SYNTHESISER', sigterm === '', sigterm)
      // …and the 400 MB stays loaded: forgetting one style must not cost the
      // two-second cold load again.
      const tWarm = Date.now()
      await speak({ text: 'Ещё раз.', voice: 'F1', lang: 'ru', steps: 4 })
      const warmMs = Date.now() - tWarm
      check('and the model stays loaded — a warm synthesis is fast', warmMs < 2_500, { warmMs })
      removeCustomVoice(reimport.id)
      check('and it cleans up after itself', !existsSync(customVoicePath(reimport.id)))
    }
  }
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\ntts probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

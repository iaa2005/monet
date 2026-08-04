/**
 * The on-device speech engine, end to end.
 *
 * Two things are worth pinning. The catalogue: a wrong URL or a filename with
 * a directory in it produces a download that "succeeds" into the wrong place
 * and a model that never loads. And the install/uninstall arithmetic: a
 * half-downloaded file must never count as installed, because the failure
 * then surfaces as an ONNX parse error nobody can act on.
 *
 * The recognizer itself is exercised only when the model is already on disk —
 * a probe does not download 230 MB. With it present, this is the real thing:
 * the recognizer process, the native module, Russian audio in, text out.
 *
 *   npm run smoke:gigaam
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'stt-probe-'))
setDataDir(tempData)

const {
  STT_MODELS,
  DEFAULT_STT_MODEL,
  sttModel,
  modelBytes,
  fileUrl,
  fileName,
  formatBytes,
  sherpaModelConfig,
  downloadProblem,
} = await import('../src/main/stt/catalog.js')
const { listSttModels, modelsDir, sttNativeAvailable, transcribePcm } =
  await import('../src/main/stt/gigaam.js')

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

check('the default model is in the catalogue', !!sttModel(DEFAULT_STT_MODEL))
check(
  'every model has a tokens file and a way to decode',
  STT_MODELS.every(
    (m) =>
      m.files.some((f) => f.role === 'tokens') &&
      (m.kind === 'ctc'
        ? m.files.some((f) => f.role === 'model')
        : ['encoder', 'decoder', 'joiner'].every((r) =>
            m.files.some((f) => f.role === r),
          )),
  ),
  STT_MODELS.map((m) => ({ id: m.id, kind: m.kind, roles: m.files.map((f) => f.role) })),
)
check(
  'ids are unique',
  new Set(STT_MODELS.map((m) => m.id)).size === STT_MODELS.length,
)
check(
  'a saved filename never carries a directory',
  STT_MODELS.every((m) => m.files.every((f) => !fileName(f).includes('/'))),
)
check(
  'every download URL is an https huggingface resolve link',
  STT_MODELS.every((m) =>
    m.files.every((f) =>
      /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/main\//.test(fileUrl(m, f)),
    ),
  ),
  STT_MODELS.map((m) => fileUrl(m, m.files[0])),
)
check(
  'sizes are plausible (a 230 MB model, not a 0-byte one)',
  STT_MODELS.every((m) => modelBytes(m) > 100_000_000 && modelBytes(m) < 1_000_000_000),
  STT_MODELS.map((m) => [m.id, formatBytes(modelBytes(m))]),
)
check('formatBytes rounds to MB', formatBytes(224_570_820) === '225 MB')
check(
  'a model kept in a repo subdirectory is still saved as a plain filename',
  STT_MODELS.some((m) => m.files.some((f) => f.path.includes('/'))) &&
    STT_MODELS.every((m) => m.files.every((f) => !fileName(f).includes('/'))),
  STT_MODELS.flatMap((m) => m.files.map((f) => [f.path, fileName(f)])),
)

// ─── The recognizer config ──────────────────────────────────────────────
// Getting this wrong surfaces as an ONNX parse error a hundred lines away.

const tCfg = sherpaModelConfig('transducer', {
  encoder: 'E',
  decoder: 'D',
  joiner: 'J',
  tokens: 'T',
}) as { transducer?: Record<string, string>; modelType?: string }
check(
  'a transducer names all three networks',
  tCfg.transducer?.encoder === 'E' &&
    tCfg.transducer?.decoder === 'D' &&
    tCfg.transducer?.joiner === 'J' &&
    tCfg.modelType === 'nemo_transducer',
  tCfg,
)
const cCfg = sherpaModelConfig('ctc', { model: 'M', tokens: 'T' }) as {
  nemoCtc?: { model?: string }
  transducer?: unknown
}
check(
  'a CTC pack points at the MODEL file, not the tokens',
  cCfg.nemoCtc?.model === 'M' && !cCfg.transducer,
  cCfg,
)

// ─── What counts as a finished download ─────────────────────────────────
// The bug this pins: right size, wrong bytes, and a recognizer that dies
// with a C++ exception instead of an error message.

const big = STT_MODELS[0].files[0]
check(
  'a file that matches its published hash and size is accepted',
  downloadProblem(big, big.sha256 as string, big.bytes) === null,
)
check(
  'the right number of WRONG bytes is rejected',
  (downloadProblem(big, 'a'.repeat(64), big.bytes) ?? '').includes('corrupt'),
  downloadProblem(big, 'a'.repeat(64), big.bytes),
)
check(
  'a truncated file is rejected even when the hash check cannot run',
  (downloadProblem({ ...big, sha256: undefined }, '', big.bytes - 1) ?? '').includes(
    'expected',
  ),
)
check(
  'a small file with no published hash still passes on its size',
  downloadProblem(
    STT_MODELS[0].files.find((f) => f.role === 'tokens') as typeof big,
    '',
    13_354,
  ) === null,
)

// ─── Install state ──────────────────────────────────────────────────────

const first = STT_MODELS[0]
let list = await listSttModels()
check(
  'nothing is installed in a fresh data dir',
  list.every((m) => !m.installed && m.onDisk === 0),
  list.map((m) => [m.id, m.installed, m.onDisk]),
)

// A download that died halfway: the .part file exists, the real one does not.
const dir = join(modelsDir(), first.id)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${fileName(first.files[0])}.part`), 'half a model')
list = await listSttModels()
check(
  'a half-finished download does NOT count as installed',
  list.find((m) => m.id === first.id)?.installed === false,
)
check(
  'and its bytes are not counted as a model on disk',
  list.find((m) => m.id === first.id)?.onDisk === 0,
)

// All the files present (empty stand-ins won't load, but the state machine
// only asks whether they are there and non-empty).
for (const f of first.files) writeFileSync(join(dir, fileName(f)), 'x')
list = await listSttModels()
check(
  'every file present reads as installed',
  list.find((m) => m.id === first.id)?.installed === true,
)
// An empty file is what a disk-full write leaves behind.
writeFileSync(join(dir, fileName(first.files[0])), '')
list = await listSttModels()
check(
  'a zero-byte file is not a model',
  list.find((m) => m.id === first.id)?.installed === false,
)
rmSync(dir, { recursive: true, force: true })

// ─── The real thing, when the model is already downloaded ───────────────

// Wherever the app on this machine keeps its data: the dev default, the
// override this repo uses, or a directory named on the command line. The
// point is that the probe covers the model the USER downloaded, rather than
// a second copy it fetched for itself.
const candidates = [
  process.env.STT_PROBE_MODEL_DIR,
  resolve('..', '.monet-prod', 'stt-models', DEFAULT_STT_MODEL),
  resolve('..', '.monet', 'stt-models', DEFAULT_STT_MODEL),
  join(homedir(), '.monet-prod', 'stt-models', DEFAULT_STT_MODEL),
  join(homedir(), '.monet', 'stt-models', DEFAULT_STT_MODEL),
].filter(Boolean) as string[]
const useDir = candidates.find((d) => existsSync(d)) ?? candidates[1]

// Eleven seconds of Russian, published beside the model. Fetched once into
// the temp dir; without it there is nothing to recognise.
async function sampleWav(): Promise<string | null> {
  if (process.env.STT_PROBE_WAV && existsSync(process.env.STT_PROBE_WAV))
    return process.env.STT_PROBE_WAV
  const cache = join(tmpdir(), 'stt-probe-example.wav')
  if (existsSync(cache)) return cache
  try {
    const model = sttModel(DEFAULT_STT_MODEL)
    if (!model) return null
    const res = await fetch(
      `https://huggingface.co/${model.repo}/resolve/main/test_wavs/example.wav`,
      { signal: AbortSignal.timeout(30_000) },
    )
    if (!res.ok) return null
    writeFileSync(cache, Buffer.from(await res.arrayBuffer()))
    return cache
  } catch {
    return null
  }
}
const sample = existsSync(useDir) ? await sampleWav() : null

if (!sttNativeAvailable()) {
  console.log('SKIP  native runtime not installed on this platform')
} else if (!existsSync(useDir) || !sample) {
  console.log(
    `SKIP  transcription (no model in ${useDir}${existsSync(useDir) ? ', and no sample audio' : ''}) — download it in the mic panel to cover this`,
  )
} else {
  // Point the engine at the directory that actually holds the model.
  setDataDir(join(useDir, '..', '..'))
  // The engine forks its child from beside its own bundle. Under the probe
  // bundler that is out-smoke/ (or out-smoke/assets/ once it splits), so put
  // the built child there — this probe runs the SHIPPED recognizer process,
  // not a copy of its logic.
  const builtChild = resolve('out/main/gigaam-child.js')
  if (!existsSync(builtChild)) {
    console.log('SKIP  transcription (run `npm run build` first — no built child)')
    rmSync(tempData, { recursive: true, force: true })
    process.exit(failures === 0 ? 0 : 1)
  }
  // It imports shared chunks by relative path, so those travel with it.
  const copyWithChunks = (from: string, toDir: string): void => {
    mkdirSync(toDir, { recursive: true })
    const name = basename(from)
    copyFileSync(from, join(toDir, name))
    const src = readFileSync(from, 'utf8')
    for (const m of src.matchAll(/from ["'](\.\/chunks\/[^"']+)["']/g)) {
      const rel = m[1].slice(2)
      const chunk = resolve('out/main', rel)
      if (!existsSync(chunk)) continue
      const target = join(toDir, 'chunks')
      if (existsSync(join(target, basename(rel)))) continue
      copyWithChunks(chunk, target)
    }
  }
  copyWithChunks(builtChild, resolve('out-smoke'))
  copyWithChunks(builtChild, resolve('out-smoke/assets'))
  const buf = readFileSync(sample)
  // 16-bit PCM WAV, walked chunk by chunk rather than assuming a 44-byte header.
  let pos = 12
  let sampleRate = 16000
  let data: Buffer | null = null
  let channels = 1
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
    } else if (id === 'data') data = buf.subarray(body, body + size)
    pos = body + size + (size % 2)
  }
  const n = Math.floor((data?.length ?? 0) / 2 / channels)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = (data as Buffer).readInt16LE(i * 2 * channels) / 32768

  const t0 = Date.now()
  const res = await transcribePcm(DEFAULT_STT_MODEL, samples, sampleRate)
  const ms = Date.now() - t0
  check('real audio comes back as text', res.ok && (res.text?.length ?? 0) > 10, res)
  check(
    'the text is Russian, not empty transliteration',
    /[а-яё]/i.test(res.text ?? ''),
    res.text,
  )
  check(
    'the punctuated model writes punctuation',
    /[.,!?]/.test(res.text ?? ''),
    res.text,
  )
  const seconds = n / sampleRate
  check(
    'faster than real time by a wide margin',
    ms < seconds * 1000 * 0.5,
    { audioSeconds: +seconds.toFixed(1), ms },
  )
  console.log(`      ${seconds.toFixed(1)}s audio → ${ms}ms: ${JSON.stringify(res.text)}`)
  const missing = await transcribePcm('no-such-model', samples, sampleRate)
  check('an unknown model id fails cleanly', !missing.ok && !!missing.error, missing)
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\nstt probe OK' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

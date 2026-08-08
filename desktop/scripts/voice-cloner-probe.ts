/**
 * The cloner handover: does a runnable project actually land on disk?
 *
 * The optimisation itself is Python and is not run here (it takes twenty
 * minutes and two gigabytes of torch). What IS pinned is everything the app is
 * responsible for: the template arrives complete, the recording becomes a WAV
 * a decoder will accept, the command names the right files, and the folder
 * sits next to the model so clone.py finds it with no path to configure.
 *
 * Also that clone.py is syntactically valid Python, when python is on PATH —
 * a template that cannot even be parsed is the one failure the user would hit
 * after installing two gigabytes of dependencies.
 *
 *   npm run smoke:voicecloner
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'cloner-probe-'))
setDataDir(tempData)

// The cloner optimises against the real synthesiser, so prepareCloner refuses
// to hand over a project when the voice model is absent. One empty file is
// enough to stand for it here — this probe tests the handover, not synthesis.
mkdirSync(join(tempData, 'tts-models', 'supertonic-3'), { recursive: true })
writeFileSync(join(tempData, 'tts-models', 'supertonic-3', 'vocoder.onnx'), '')

const { prepareCloner, clonerDir } = await import('../src/main/tts/voice-cloner.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── The template ───────────────────────────────────────────────────────

const template = resolve('resources/voice-cloner')
const shipped = readdirSync(template)
check('the template ships a program, its deps and its README',
  ['clone.py', 'requirements.txt', 'README.md'].every((f) => shipped.includes(f)), shipped)

const py = readFileSync(join(template, 'clone.py'), 'utf-8')
check(
  'clone.py writes the shape the app imports — [1,50,256] and [1,8,16]',
  py.includes('"dims": [1, 50, 256]') && py.includes('"dims": [1, 8, 16]'),
)
check(
  'and it passes the estimator its arguments in the GRAPH\'s order',
  // Cost an afternoon: the app passes these by name, the torch module by
  // position, and the order is not the obvious one.
  /latent_mask,\s*\n\s*mask,\s*\n\s*torch\.tensor\(\[float\(step\)\]/.test(py),
)
check(
  'the measured step size is the default, not the one that destroyed the voice',
  /default=1e-3/.test(py) && !/default=0\.02\)/.test(py),
)
// Reported from a real run: the transfer died at 28.5 of 29.3 MB and the stump
// stayed on disk, so the next run read it as the model and failed on
// "Protobuf parsing failed".
check(
  'THE DOWNLOAD CANNOT LEAVE A STUMP BEHIND — part file, size, checksum',
  /\.part/.test(py) &&
    /hashlib\.sha256/.test(py) &&
    /Range/.test(py) &&
    /st_size != SPEAKER_BYTES/.test(py),
)
check(
  'the ONNX shims it needs are both there',
  /widen_converter_registry/.test(py) && /def declip/.test(py),
)

// ─── The handover ───────────────────────────────────────────────────────

const RATE = 16_000
const samples = new Float32Array(RATE * 12)
for (let i = 0; i < samples.length; i++)
  samples[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.3

const r = prepareCloner({ samples, sampleRate: RATE, name: 'Саша', lang: 'ru' })
check('the project is prepared', r.ok, r)
check('inside the data dir, beside tts-models', r.dir === clonerDir() && r.dir?.startsWith(tempData), r.dir)
check('the recording is 12 seconds long', Math.abs((r.seconds ?? 0) - 12) < 0.01, r.seconds)
check(
  'every template file is copied over',
  ['clone.py', 'requirements.txt', 'README.md'].every((f) => existsSync(join(clonerDir(), f))),
)

const wav = readFileSync(join(clonerDir(), 'voice.wav'))
check('the recording is a real RIFF/WAVE file', wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE')
check(
  'mono, 16 kHz, 16-bit — and the header agrees with the payload',
  wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === RATE &&
    wav.readUInt16LE(34) === 16 &&
    wav.readUInt32LE(40) === samples.length * 2 &&
    wav.length === 44 + samples.length * 2,
  { channels: wav.readUInt16LE(22), rate: wav.readUInt32LE(24), bits: wav.readUInt16LE(34) },
)
check(
  'and it is not silence — a written-but-empty wav is the classic version of this bug',
  Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(wav.readInt16LE(44 + i * 2)))) > 1000,
)

check(
  'THE COMMAND NAMES THE FILES THAT EXIST',
  r.command?.includes('clone.py') === true &&
    r.command?.includes('voice.wav') === true &&
    r.command?.includes('--lang ru') === true,
  r.command,
)
// The first real run happened in a data dir with no voice model, where
// clone.py's "look next to me" default pointed at nothing.
check(
  'AND SPELLS OUT THE MODEL PATH, so it works from any folder',
  r.command?.includes(`--models "${join(tempData, 'tts-models', 'supertonic-3')}"`) === true,
  r.command,
)
check(
  'while a data dir without the voice model is refused up front',
  (() => {
    rmSync(join(tempData, 'tts-models', 'supertonic-3', 'vocoder.onnx'))
    const no = prepareCloner({ samples, sampleRate: RATE, name: 'x', lang: 'ru' })
    writeFileSync(join(tempData, 'tts-models', 'supertonic-3', 'vocoder.onnx'), '')
    return !no.ok && /voice model first/.test(no.error ?? '')
  })(),
)
check('a Cyrillic name survives into the command, quoted', r.command?.includes('"Саша"') === true, r.command)
check(
  'a nameless run still gets a name',
  prepareCloner({ samples, sampleRate: RATE, name: '   ', lang: 'en' }).command?.includes('"my-voice"') === true,
)

// Preparing twice must not destroy a result from the first run.
const mine = join(clonerDir(), 'Саша.json')
writeFileSync(mine, '{"style_ttl":1}', 'utf-8')
prepareCloner({ samples, sampleRate: RATE, name: 'Саша', lang: 'ru' })
// Read defensively: a wipe would make this throw instead of fail, and a probe
// that explodes reports nothing (found by breaking exactly that).
const survived = existsSync(mine) ? readFileSync(mine, 'utf-8') : '(deleted)'
check('PREPARING AGAIN LEAVES A FINISHED VOICE ALONE', survived === '{"style_ttl":1}', survived)

// ─── Is it Python? ──────────────────────────────────────────────────────

try {
  execFileSync('python', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', join(clonerDir(), 'clone.py')], { stdio: 'pipe' })
  check('clone.py parses as Python', true)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT/.test(msg)) console.log('SKIP  clone.py parse check (no python on PATH)')
  else check('clone.py parses as Python', false, msg.slice(0, 300))
}

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\nthe handover is complete' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

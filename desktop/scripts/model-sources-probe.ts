/**
 * Every model this app downloads comes from ONE account.
 *
 * Not a style rule. The app used to fetch weights from six accounts —
 * csukuangfj, fussraider, Xenova, Supertone, onnx-community, PaddlePaddle
 * — and any one of those can rename a repo, gate it behind a licence
 * click, or delete it. The user finds out as a 404 halfway through a
 * download, for something they did not do. So the models are mirrored,
 * with the originals credited, and this is what stops the next model added
 * from quietly reintroducing the problem.
 *
 * It reads the CATALOGUES, which is where a new model gets added, and it
 * greps the source for hub URLs, which is where one gets added by
 * accident.
 *
 *   npm run smoke:sources
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OWNER = 'iaa2005'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const { STT_MODELS } = await import('../src/main/stt/catalog.js')
const { TTS_REPO } = await import('../src/main/tts/catalog.js')
const { ALL_MODELS } = await import('../src/main/ocr/catalog.js')
const { LAYOUT_REPO } = await import('../src/main/ocr/layout.js')
const { DET_REPO } = await import('../src/main/ocr/lines/detect.js')
const { WHISPER_TIERS } = await import('../src/shared/whisper-tier.js')

// ─── The catalogues ─────────────────────────────────────────────────────

{
  const sources: { what: string; repo: string; offered: boolean }[] = [
    ...STT_MODELS.map((m) => ({ what: `stt/${m.id}`, repo: m.repo, offered: true })),
    ...WHISPER_TIERS.map((m) => ({ what: `stt/${m.id}`, repo: m.id, offered: true })),
    { what: 'tts', repo: TTS_REPO, offered: true },
    ...ALL_MODELS.map((m) => ({
      what: `ocr/${m.id}`,
      repo: m.repo,
      offered: m.enabled,
    })),
    { what: 'ocr/layout', repo: LAYOUT_REPO, offered: true },
    { what: 'ocr/lines', repo: DET_REPO, offered: true },
  ]

  check('every subsystem was found', sources.length >= 12, sources.length)
  for (const { what, repo, offered } of sources) {
    if (!offered) continue
    check(
      `${what} is fetched from the mirror account`,
      repo.startsWith(`${OWNER}/`),
      repo,
    )
  }

  // A SHELVED model may still name somebody else's repo — one of them
  // does, deliberately, because it declares no licence and copying it
  // would be redistributing something nobody granted. That is fine while
  // it stays off, and is a trap the moment somebody flips `enabled`, so
  // it is named here rather than left to be discovered in a download.
  const unmirrored = sources.filter((s) => !s.repo.startsWith(`${OWNER}/`))
  check(
    'anything left on another account is a model nobody is offered',
    unmirrored.every((s) => !s.offered),
    unmirrored,
  )
  if (unmirrored.length)
    console.log(
      `      (not mirrored: ${unmirrored
        .map((s) => `${s.what} → ${s.repo}`)
        .join(', ')} — enabling one means mirroring it first)`,
    )
}

// ─── And nothing sneaks in through a URL ────────────────────────────────

{
  // A repo id spelled into a fetch() rather than into a catalogue is the
  // way this comes back. Vendored third-party code is not ours to police.
  const roots = ['src/main', 'src/renderer', 'src/shared']
  const skip = /node_modules|vendor[\\/]leaked/
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (skip.test(path)) continue
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(path)) files.push(path)
    }
  }
  for (const root of roots) walk(root)

  const HOLE = '@@'
  const hubPath = /huggingface\.co\/([\w.-]+)\/([\w.-]+)/g
  const foreign: { file: string; owner: string }[] = []
  for (const file of files) {
    // The downloaders build their URLs by interpolation —
    // `huggingface.co/api/models/${repo}` — and a template hole is not an
    // account name, so the holes are blanked first. `api/models/` goes
    // too: it is a path, and left in it reads as owner "api", repo
    // "models", which is how this first reported the downloader itself as
    // a foreign dependency.
    const text = readFileSync(file, 'utf-8')
      .replace(/\$\{[^}]*\}/g, HOLE)
      .replace(/huggingface\.co\/api\/models\//g, 'huggingface.co/')
    for (const m of text.matchAll(hubPath)) {
      const owner = m[1]
      if (owner.includes(HOLE)) continue
      if (owner !== OWNER) foreign.push({ file, owner })
    }
  }
  check('no hub URL names another account outright', foreign.length === 0, foreign)
}

console.log(failures ? `\n${failures} FAILED` : '\nALL MODEL SOURCES ON ONE ACCOUNT')
process.exit(failures ? 1 : 0)

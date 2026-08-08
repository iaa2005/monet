/**
 * Who the agent says it is.
 *
 * Live, 2026-08-08, DeepSeek, first message of a chat: «Привет! Как тебя
 * зовут?» → «Меня зовут Марина. Я ваша помощница по задачам программирования».
 * Nothing in the prompt had said otherwise, and the second sentence is our own
 * intro line played back — so the model filled the empty slot from training.
 *
 * What is pinned here is that the slot is no longer empty, that the model id
 * comes from the APP (a model asked which model it is answers from training
 * data, and gets it wrong the moment the user switches providers), and — the
 * part a builder-only test would miss — that the block is actually folded into
 * the system prompt. That last check reads the source: importing agent/index.ts
 * under the stub drags in sqlite, providers and the vendor runtime, and a probe
 * that cannot run is worse than one that greps.
 *
 *   npm run smoke:identity
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

// FIRST, before anything resolves getDataDir(): the seeded prompt file goes to
// a temp dir, never the developer's own .monet.
const tempData = mkdtempSync(join(tmpdir(), 'identity-probe-'))
setDataDir(tempData)

const { agentIdentityPrompt, IDENTITY_DEFAULT } = await import('../src/main/agent/identity.js')
const { reloadPrompts } = await import('../src/main/prompts/index.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── What it says ───────────────────────────────────────────────────────

const text = agentIdentityPrompt()
check('the app is named', /Code Monet/.test(text), text)
check(
  'IT IS TOLD NOT TO INVENT A NAME',
  /do not invent a name/i.test(text),
  text,
)
check('and not to claim to be a person', /not claim to be a person/i.test(text))
check('and not to adopt a persona', /persona/i.test(text))
check(
  'it is a heading, so it survives being pasted between other blocks',
  text.startsWith('# '),
)
// A block paid on every single turn: worth stating, not worth paragraphs.
check('and it stays cheap — under ~120 tokens', text.length < 480, text.length)

// ─── The model id is the app's fact, not the model's guess ──────────────

const withModel = agentIdentityPrompt('deepseek/deepseek-chat')
check(
  'the model the app dispatched to is stated',
  withModel.includes('`deepseek/deepseek-chat`'),
  withModel.slice(-120),
)
check('without a model nothing is claimed', !/running on the model/.test(text))
check(
  'and the identity itself is unchanged by it',
  withModel.startsWith(text),
)

// ─── It is a tunable prompt like the others ────────────────────────────

const file = join(tempData, 'prompts', 'identity.md')
check('the default is seeded to disk for editing', readFileSync(file, 'utf-8') === IDENTITY_DEFAULT)
writeFileSync(file, '# Who you are\nYou are Марина.', 'utf-8')
reloadPrompts()
check(
  'an edited file wins — the user can rename the thing if they want to',
  agentIdentityPrompt().includes('Марина'),
  agentIdentityPrompt(),
)

// ─── …and it is actually IN the prompt ──────────────────────────────────

const src = readFileSync('src/main/agent/index.ts', 'utf-8')
const fold = src.slice(src.indexOf('function withUserMemory'), src.indexOf('function seedTunablePrompts'))
check(
  'THE BLOCK IS FOLDED INTO EVERY SYSTEM PROMPT',
  /agentIdentityPrompt\(model\)/.test(fold),
  fold.slice(0, 400),
)
check(
  'before the user profile: what it is, then who the user is',
  fold.indexOf('agentIdentityPrompt') < fold.indexOf('getProfilePrompt'),
)
check(
  'both prompt paths pass the model down — vendor and fallback',
  (src.match(/withUserMemory\([\s\S]{0,120}?model,?\s*\)/g) ?? []).length === 2,
  src.match(/withUserMemory\([^)]*\)/g),
)
check(
  'and it is seeded with the rest, so the prompts folder is complete',
  /agentIdentityPrompt\(\);/.test(src),
)

rmSync(tempData, { recursive: true, force: true })
console.log(failures === 0 ? '\nit knows what it is' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

/**
 * The live matrix — the real app, the real model, the real folder.
 *
 * Everything else in scripts/ tests a piece with the rest held still. This
 * boots the BUILT app — the same `electron .` the user runs — points it at a
 * throwaway data dir carrying a copy of their provider config, and drives it
 * over the dev-only local API with real DeepSeek calls. Then it asks the
 * questions a unit test cannot:
 *
 *   - when a prompt is taken out of context, does the MODEL stop knowing it?
 *   - when a turn is rewound, does the file the user typed meanwhile survive?
 *   - when the window fills and compaction fires, does the fact stated before
 *     it still come back — and does a prompt the user removed stay removed?
 *
 * The last one is why this exists: compaction, undo and "remove this prompt"
 * are three levers on one flag, and only a live run shows what happens when
 * two of them are pulled in the same session.
 *
 * Nothing touches the user's real data: MONET_DATA_DIR gives the app its own
 * folder, and the work trees are temp dirs. The provider file is COPIED, so
 * the key is only ever read.
 *
 *   npm run live:matrix              # everything (~10 min, ~40 real turns)
 *   npm run live:matrix code_undo    # one scenario
 *
 * Scenarios: code_undo, code_rewind, code_contested, manual_compact,
 * edit_retry, home, auto_compact, compact_undo, rewind_after_compact,
 * home_compact, home_podman. One app is booted per compaction threshold —
 * MONET_COMPACT_TOKENS is read once, when the module loads.
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')

/** Only to tell "not built yet" from "broken" — the app is launched below. */
const MAIN = resolve('out/main/index.js')
// Launched as `electron .`, NOT `electron out/main/index.js`. The difference
// is app.getName(), and therefore userData — and Chromium keeps the key that
// safeStorage encrypts with in userData/Local State. Run under the wrong name
// and the provider's API key decrypts to its own ciphertext, which the API
// answers with a 401 that looks exactly like a bad key.
const APP_DIR = resolve('.')
const SOURCE_DATA_DIR =
  process.env.LIVE_SOURCE_DATA_DIR ?? resolve('..', '.monet-prod')
const PORT = Number(process.env.LIVE_API_PORT ?? 8791)
/** One turn of a real model, with tools, is not fast — and the first turn
 * after a boot pays for the prompt build, the skills seeding and whatever
 * DeepSeek's queue is doing. Seen: 64s for one 300-word answer. */
const TURN_TIMEOUT_MS = 600_000

// ─── Reporting ──────────────────────────────────────────────────────────

let failures = 0
let checks = 0
const failedNames = []

function check(name, cond, detail) {
  checks++
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    failedNames.push(name)
    const d = detail === undefined ? '' : ` — ${trim(detail)}`
    console.log(`  FAIL  ${name}${d}`)
  }
  return cond
}

function trim(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : String(s)
}

const say = (m) => console.log(m)

// ─── The app under test ─────────────────────────────────────────────────

/** Boot the built app with its own data dir, and wait for the dev API. */
async function bootApp(env) {
  const dataDir = mkdtempSync(join(tmpdir(), 'live-matrix-data-'))
  const providers = join(dataDir, 'providers')
  mkdirSync(providers, { recursive: true })
  const src = join(SOURCE_DATA_DIR, 'providers', 'providers.json')
  if (!existsSync(src))
    throw new Error(
      `no provider config at ${src} — set LIVE_SOURCE_DATA_DIR to a data dir that has one`,
    )
  copyFileSync(src, join(providers, 'providers.json'))

  // The app finds its portable podman under its OWN data dir, and this one is
  // a fresh temp folder — so hand it the real install on PATH instead of
  // copying a few hundred megabytes. Ignored by every scenario but the one
  // that runs code inside a container.
  const podmanBin = join(SOURCE_DATA_DIR, 'podman', 'bin')
  const withPodman = existsSync(join(podmanBin, 'podman.exe'))
    ? `${podmanBin};${process.env.PATH ?? ''}`
    : process.env.PATH

  const child = spawn(electron, [APP_DIR], {
    env: {
      ...process.env,
      PATH: withPodman,
      MONET_DATA_DIR: dataDir,
      MONET_DEV_API: '1',
      MONET_DEV_API_PORT: String(PORT),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))

  const info = join(dataDir, 'dev-api.json')
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    if (existsSync(info)) {
      try {
        const cfg = JSON.parse(readFileSync(info, 'utf8'))
        const api = makeApi(cfg.port, cfg.token)
        await api.get('/health')
        return { child, dataDir, api, log: () => log }
      } catch {
        /* still starting */
      }
    }
    if (child.exitCode !== null)
      throw new Error(`the app exited (${child.exitCode})\n${log.slice(-2000)}`)
    await sleep(300)
  }
  child.kill()
  throw new Error(`the app never opened its dev API\n${log.slice(-3000)}`)
}

function makeApi(port, token) {
  const once = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    })
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`)
    }
    if (!res.ok)
      throw new Error(`${path} → ${res.status}: ${trim(parsed.error ?? parsed)}`)
    return parsed
  }
  // One retry, and only when the network stalled — said out loud, because a
  // silent retry turns a hang into a slow pass. Anything the app answered,
  // including an error, stands.
  const call = async (method, path, body) => {
    try {
      return await once(method, path, body)
    } catch (err) {
      if (!/timeout|aborted/i.test(err.message)) throw err
      say(`    ! ${path} timed out after ${TURN_TIMEOUT_MS / 1000}s — retrying once`)
      return once(method, path, body)
    }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Send a real prompt and return the whole turn.
 *
 * Long-term memory is OFF for every one of these. Half the matrix works by
 * telling the model a word and then checking whether it still knows it — and
 * the model, being helpful, reaches for the Remember tool. The word then
 * lands in the memory file, every later session in this data dir reads it,
 * and a check about the CONTEXT passes for a reason that has nothing to do
 * with the context. Measured: a Home chat "remembered" a word that had been
 * taken out, and a chat in another session knew a code word it was never
 * told. */
async function ask(api, body) {
  const t0 = Date.now()
  const r = await api.post('/chat', { memory: false, ...body })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  say(
    `    → "${String(body.message).slice(0, 52)}…" (${secs}s, ${r.toolCalls} tools) ${JSON.stringify(
      (r.text ?? '').trim().slice(0, 70),
    )}`,
  )
  return r
}

/** A throwaway folder with one file in it that belongs to nobody but the user. */
function workspace(seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-matrix-work-'))
  for (const [rel, text] of Object.entries(seed)) put(dir, rel, text)
  return dir
}

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true })
  writeFileSync(join(dir, rel), text, 'utf8')
}

/** Windows keeps a handle on a folder the agent just worked in for a moment
 * after; a temp dir that outlives the run is not worth failing a check for. */
function discard(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* it is in TEMP; the OS will get to it */
  }
}

function read(dir, rel) {
  const p = join(dir, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

const has = (text, needle) =>
  String(text ?? '').toUpperCase().includes(needle.toUpperCase())

/**
 * Fill the window with real conversation.
 *
 * Compaction only pays when the part being summarised is much larger than
 * the summary, which has a floor of several hundred tokens whatever it is
 * given. Short chats therefore compact to something BIGGER than themselves —
 * which is now refused, so a scenario that wants to see a real compaction
 * has to give it real material.
 */
const SUBJECTS = [
  'a rainy street at night',
  'a sunny beach at noon',
  'a mountain railway',
  'a harbour at dawn',
  'a bookshop in winter',
  'a market square in summer',
]

async function fill(api, s, cwd, n) {
  for (let i = 0; i < n; i++)
    await ask(api, {
      message: `Write about 300 words describing ${SUBJECTS[i % SUBJECTS.length]}. Prose only, no lists.`,
      sessionId: s,
      cwd,
      maxTurns: 3,
    })
}

// ─── Scenarios ──────────────────────────────────────────────────────────

const scenarios = []
const scenario = (name, compactTokens, run) =>
  scenarios.push({ name, compactTokens, run })

// 1 ─ A prompt removed from context is a prompt the model no longer knows.
scenario('code_undo', null, async (api) => {
  const cwd = workspace({ 'keep.txt': "the user's own file\n" })
  const t1 = await ask(api, {
    message: 'Keep this word in mind for later: ALPHA-731. Do not use any tools. Reply with only: ok',
    cwd,
    maxTurns: 3,
  })
  const s = t1.sessionId
  await ask(api, {
    message: 'Keep this word in mind too: BRAVO-842. Do not use any tools. Reply with only: ok',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })

  const before = await api.get(`/context/${s}`)
  check('both prompts are in context', before.turns.length === 2 && before.turns.every((t) => t.inContext), before.turns)
  check('and the chat can address them by id', before.turns[0].id === t1.userMessageId, {
    got: before.turns[0].id,
    want: t1.userMessageId,
  })

  const off = await api.post(`/context/${s}`, {
    messageId: t1.userMessageId,
    inContext: false,
  })
  check('removing the first prompt marks its whole turn', off.changed >= 2, off)
  check(
    'the message is still in the transcript, not deleted',
    off.context.stored.messages === before.stored.messages,
    { now: off.context.stored.messages, was: before.stored.messages },
  )
  check(
    '…and the flag is on disk, not only in memory',
    off.context.stored.inContext < off.context.stored.messages,
    off.context.stored,
  )
  check(
    'the token estimate drops with it',
    off.context.inContextTokens < off.context.allTokens,
    { inContext: off.context.inContextTokens, all: off.context.allTokens },
  )

  const q = 'Which words was I told to remember? List them, nothing else.'
  const t3 = await ask(api, { message: q, sessionId: s, cwd, maxTurns: 3 })
  check('THE MODEL NO LONGER KNOWS the removed word', !has(t3.text, 'ALPHA-731'), t3.text)
  check('…and still knows the one left in', has(t3.text, 'BRAVO-842'), t3.text)

  // Put it back — and take the question out, since its answer names a word.
  await api.post(`/context/${s}`, { messageId: t1.userMessageId, inContext: true })
  await api.post(`/context/${s}`, { messageId: t3.userMessageId, inContext: false })
  const t4 = await ask(api, { message: q, sessionId: s, cwd, maxTurns: 3 })
  check('restoring the prompt gives the word back', has(t4.text, 'ALPHA-731'), t4.text)

  check(
    'no file was touched by any of this',
    read(cwd, 'keep.txt') === "the user's own file\n",
    read(cwd, 'keep.txt'),
  )
  discard(cwd)
})

// 2 ─ A rewind undoes the turns and leaves the user's own work alone.
scenario('code_rewind', null, async (api) => {
  const cwd = workspace({ 'keep.txt': 'untouched by anybody\n' })
  const write = (name, text) =>
    `Use the Write tool to create a file named ${name} in the current directory ` +
    `containing exactly this one line: ${text}. Then reply with only: done`

  const t1 = await ask(api, { message: write('notes.txt', 'turn-one'), cwd, maxTurns: 6 })
  const s = t1.sessionId
  check('the first turn wrote its file', read(cwd, 'notes.txt') !== null, read(cwd, 'notes.txt'))
  check('and left a checkpoint', !!t1.checkpointSha, t1.checkpointSha)

  // The user, working in the same folder while the chat goes on.
  put(cwd, 'mine.txt', 'typed by hand between turns\n')

  const t2 = await ask(api, {
    message: write('second.txt', 'turn-two'),
    sessionId: s,
    cwd,
    maxTurns: 6,
  })
  const t3 = await ask(api, {
    message: write('third.txt', 'turn-three'),
    sessionId: s,
    cwd,
    maxTurns: 6,
  })
  check('two more turns, two more files', read(cwd, 'second.txt') !== null && read(cwd, 'third.txt') !== null)
  check('and each has its own checkpoint', t2.checkpointSha !== t1.checkpointSha && t3.checkpointSha !== t2.checkpointSha)

  const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
  check('the rewind succeeds', r.ok, r)
  check('it works in the folder the chat used', r.folder === cwd, { got: r.folder, want: cwd })
  check('the files of both later turns are gone', read(cwd, 'second.txt') === null && read(cwd, 'third.txt') === null, {
    second: read(cwd, 'second.txt'),
    third: read(cwd, 'third.txt'),
  })
  check('the first turn’s file survives', read(cwd, 'notes.txt') !== null)
  check(
    "THE USER'S OWN FILE IS UNTOUCHED",
    read(cwd, 'mine.txt') === 'typed by hand between turns\n',
    read(cwd, 'mine.txt'),
  )
  check('and so is the file nobody touched', read(cwd, 'keep.txt') === 'untouched by anybody\n')

  // Undo is the OTHER lever: it forgets, it does not restore.
  const ctxBefore = await api.get(`/context/${s}`)
  const u = await api.post(`/undo/${s}`, { count: 1 })
  check('undo removes one prompt from context', u.removed === 1, u)
  check(
    '…and leaves the files exactly as the rewind left them',
    read(cwd, 'notes.txt') !== null && read(cwd, 'second.txt') === null,
  )
  check(
    '…and nothing was deleted from the transcript',
    u.context.stored.messages === ctxBefore.stored.messages,
    { now: u.context.stored.messages, was: ctxBefore.stored.messages },
  )
  discard(cwd)
})

// 3 ─ A file both sides changed stays as the user left it.
scenario('code_contested', null, async (api) => {
  const cwd = workspace()
  const t1 = await ask(api, {
    message:
      'Use the Write tool to create shared.txt in the current directory containing exactly: from-the-model. Reply with only: done',
    cwd,
    maxTurns: 6,
  })
  const s = t1.sessionId
  const t2 = await ask(api, {
    message:
      'Use the Write tool to overwrite shared.txt so it contains exactly: model-second-version. Reply with only: done',
    sessionId: s,
    cwd,
    maxTurns: 6,
  })
  check('the model wrote the file twice', read(cwd, 'shared.txt') !== null, read(cwd, 'shared.txt'))

  // …and then the user opens it and types over the top.
  put(cwd, 'shared.txt', 'typed by hand, exists nowhere else\n')

  const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
  check('the rewind still succeeds', r.ok, r)
  check(
    "THE USER'S VERSION IS NOT OVERWRITTEN",
    read(cwd, 'shared.txt') === 'typed by hand, exists nowhere else\n',
    read(cwd, 'shared.txt'),
  )
  check('…and the rewind says so rather than staying quiet', (r.skipped ?? []).some((p) => p.includes('shared.txt')), r.skipped)
  void t2
  discard(cwd)
})

// 4 ─ Compaction fires on its own, and what was said survives it.
scenario('auto_compact', 2500, async (api) => {
  const cwd = workspace()
  const t1 = await ask(api, {
    message: 'Keep this in mind: the vault code is ZEBRA-77. Do not use any tools. Reply with only: ok',
    cwd,
    maxTurns: 3,
  })
  const s = t1.sessionId
  await fill(api, s, cwd, 6)

  const ctx = await api.get(`/context/${s}`)
  const compactions = ctx.events.filter((e) => e.type === 'compact')
  check('auto-compaction fired without being asked', compactions.length > 0, {
    events: ctx.events,
    tokensNow: ctx.allTokens,
  })
  for (const c of compactions) {
    check(`compaction ${c.id.slice(0, 6)} was automatic, not asked for`, c.manual !== true, c)
    check(
      `compaction ${c.id.slice(0, 6)} made the context SMALLER`,
      c.afterTokens < c.beforeTokens,
      c,
    )
  }

  const t4 = await ask(api, {
    message: 'What is the vault code? Reply with only the code.',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('THE FACT SURVIVES THE SUMMARY', has(t4.text, 'ZEBRA-77'), t4.text)

  const after = await api.get(`/context/${s}`)
  check(
    'nothing was quietly dropped from context by compacting',
    after.stored.inContext === after.stored.messages,
    after.stored,
  )
  check('and every turn still has an id to address it by', after.turns.length > 0 && after.turns.every((t) => t.id), after.turns)
  discard(cwd)
})

// 5 ─ The one only a live run can answer: compaction meets a removed prompt.
scenario('compact_undo', 2500, async (api) => {
  const cwd = workspace()
  const t1 = await ask(api, {
    message: 'Keep this word in mind for later: SIGMA-9. Do not use any tools. Reply with only: ok',
    cwd,
    maxTurns: 3,
  })
  const s = t1.sessionId
  await ask(api, {
    message: 'Keep this word in mind too: OMEGA-3. Do not use any tools. Reply with only: ok',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })

  const off = await api.post(`/context/${s}`, {
    messageId: t1.userMessageId,
    inContext: false,
  })
  check('the first prompt is out of context', off.ok && off.changed > 0, off)

  // Now push the chat over the threshold, so compaction runs WITH a removed
  // turn sitting in the history.
  await fill(api, s, cwd, 6)

  const ctx = await api.get(`/context/${s}`)
  check(
    'compaction fired while a prompt was out of context',
    ctx.events.some((e) => e.type === 'compact'),
    { events: ctx.events, tokensNow: ctx.allTokens },
  )
  check(
    'a turn removed before compaction is still marked removed after it',
    ctx.stored.inContext < ctx.stored.messages,
    ctx.stored,
  )

  const t5 = await ask(api, {
    message: 'Which code words was I told to remember? List them, nothing else.',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('the word that was left in is still known', has(t5.text, 'OMEGA-3'), t5.text)
  check(
    'THE REMOVED WORD DOES NOT COME BACK THROUGH THE SUMMARY',
    !has(t5.text, 'SIGMA-9'),
    t5.text,
  )

  // And it is still reversible: the whole promise of a flag over a deletion.
  const back = await api.post(`/context/${s}`, {
    messageId: t1.userMessageId,
    inContext: true,
  })
  check('the removed prompt can still be put back after a compaction', back.ok && back.changed > 0, back)
  const t6 = await ask(api, {
    message: 'Which code words was I told to remember? List them, nothing else.',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('…and the model knows it again', has(t6.text, 'SIGMA-9'), t6.text)

  // "Rewind through compact": the pre-compaction history comes back — and it
  // is stored as plain data, so without its ids and flags travelling with it
  // every restored message returns with a new id and IN context, quietly
  // undoing the user's removal along with the compaction.
  await api.post(`/context/${s}`, { messageId: t1.userMessageId, inContext: false })
  const un = await api.post(`/uncompact/${s}`, {})
  check('the compaction can be undone', !!un.restored, un.restored)
  check(
    'the restored history is bigger than the summary was',
    un.context.allTokens > 2000,
    un.context.allTokens,
  )
  check(
    'THE REMOVED PROMPT IS STILL REMOVED AFTER UNDOING THE COMPACTION',
    un.context.turns.some((t) => !t.inContext),
    un.context.turns,
  )
  check(
    '…and the turn still answers to the id the chat knows it by',
    un.context.turns.some((t) => t.id === t1.userMessageId),
    { want: t1.userMessageId, got: un.context.turns.map((t) => t.id) },
  )
  discard(cwd)
})

// 6 ─ Compaction asked for by hand, on a chat with a prompt removed.
scenario('manual_compact', null, async (api) => {
  const cwd = workspace()
  const t1 = await ask(api, {
    message: 'Keep this word in mind for later: KILO-4. Do not use any tools. Reply with only: ok',
    cwd,
    maxTurns: 3,
  })
  const s = t1.sessionId
  const t2 = await ask(api, {
    message: 'Keep this word in mind too: LIMA-6. Do not use any tools. Reply with only: ok',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })

  // A short chat: the summary would be bigger than the conversation, and
  // pretending otherwise is what made auto-compaction loop.
  const small = await api.post(`/compact/${s}`, {})
  check(
    'compacting a short chat is declined rather than faked',
    small.compacted === null || small.compacted.after >= small.compacted.before,
    small.compacted,
  )
  check(
    '…and it did not quietly replace the conversation',
    small.context.stored.messages >= 4,
    small.context.stored,
  )

  // Now give it something worth summarising, with LIMA-6 taken out first.
  await api.post(`/context/${s}`, { messageId: t2.userMessageId, inContext: false })
  await fill(api, s, cwd, 6)

  const big = await api.post(`/compact/${s}`, {})
  check('a full chat compacts on demand', !!big.compacted && big.compacted.after < big.compacted.before, big.compacted)
  check(
    'the removed prompt is still removed after a manual compaction',
    big.context.stored.inContext < big.context.stored.messages,
    big.context.stored,
  )

  const t4 = await ask(api, {
    message: 'Which code words was I told to remember? List them, nothing else.',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('the word left in survived the manual summary', has(t4.text, 'KILO-4'), t4.text)
  check('and the removed one did not return', !has(t4.text, 'LIMA-6'), t4.text)
  discard(cwd)
})

// 7 ─ "Rewind to here", end to end: the files AND the transcript.
scenario('edit_retry', null, async (api) => {
  const cwd = workspace({ 'keep.txt': 'nobody touches this\n' })
  const write = (name, text) =>
    `Use the Write tool to create a file named ${name} in the current directory ` +
    `containing exactly this one line: ${text}. Then reply with only: done`

  const t1 = await ask(api, {
    message: 'Keep this in mind: the project is called ORION. Do not use any tools. Reply with only: ok',
    cwd,
    maxTurns: 3,
  })
  const s = t1.sessionId
  await ask(api, { message: write('draft.txt', 'first draft'), sessionId: s, cwd, maxTurns: 6 })
  const t3 = await ask(api, {
    message: 'Keep this in mind too: the deadline is FRIDAY. Do not use any tools. Reply with only: ok',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('the middle turn wrote its file', read(cwd, 'draft.txt') !== null)

  // The user edits something of their own while all that goes on.
  put(cwd, 'mine.txt', 'typed by hand, mine\n')

  // What the button does: restore the checkpoint from before the turn being
  // edited, then cut the transcript to the same place.
  const before = await api.get(`/context/${s}`)
  const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
  check('the file rewind succeeds', r.ok, r)
  const cut = await api.post(`/truncate/${s}`, {
    keepUserTurns: 1,
    totalUserTurns: before.turns.length,
  })

  check('the transcript is cut with full fidelity', cut.fidelity === 'full', cut)
  check('…to one turn', cut.context.turns.length === 1, cut.context.turns)
  check('the file that turn wrote is gone', read(cwd, 'draft.txt') === null, read(cwd, 'draft.txt'))
  check(
    "…and the user's own file is not",
    read(cwd, 'mine.txt') === 'typed by hand, mine\n',
    read(cwd, 'mine.txt'),
  )
  check('nor is the file nobody touched', read(cwd, 'keep.txt') !== null)

  // The real test of a truncation: what the model still knows.
  const t4 = await ask(api, {
    message:
      'What is the project called, and what is the deadline? If you were not told, say: not told.',
    sessionId: s,
    cwd,
    maxTurns: 3,
  })
  check('it still knows what was said before the cut', has(t4.text, 'ORION'), t4.text)
  check('AND HAS FORGOTTEN THE TURN THAT WAS CUT', !has(t4.text, 'FRIDAY'), t4.text)
  void t3
  discard(cwd)
})

// 8 ─ Home: the sandbox is a folder like any other.
scenario('home', null, async (api, ctx) => {
  const t1 = await ask(api, {
    message:
      'Use the SandboxWrite tool to save a file named notes.txt containing exactly: home-turn-one. Then reply with only: done',
    space: 'home',
    maxTurns: 6,
  })
  const s = t1.sessionId
  const box = join(ctx.dataDir, 'sandboxes', s.replace(/[^a-zA-Z0-9_-]/g, '_'))
  check('the home turn wrote into the chat’s sandbox', read(box, 'notes.txt') !== null, {
    box,
    got: read(box, 'notes.txt'),
  })
  check('and home chats get checkpoints too', !!t1.checkpointSha, t1.checkpointSha)

  put(box, 'mine.txt', 'the user dropped this in\n')

  const t2 = await ask(api, {
    message:
      'Use the SandboxWrite tool to save a file named second.txt containing exactly: home-turn-two. Then reply with only: done',
    sessionId: s,
    space: 'home',
    maxTurns: 6,
  })
  check('the second turn wrote its file', read(box, 'second.txt') !== null)

  const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
  check('a home rewind succeeds', r.ok, r)
  check('it works in the sandbox, not the workspace', r.folder === box, { got: r.folder, want: box })
  check('the second turn’s file is gone', read(box, 'second.txt') === null, read(box, 'second.txt'))
  check('the first turn’s file survives', read(box, 'notes.txt') !== null)
  check("the user's own file survives", read(box, 'mine.txt') === 'the user dropped this in\n', read(box, 'mine.txt'))

  // And the context lever works the same here.
  const t3 = await ask(api, {
    message: 'Keep this word in mind for later: DELTA-5. Do not use any tools. Reply with only: ok',
    sessionId: s,
    space: 'home',
    maxTurns: 3,
  })
  await api.post(`/context/${s}`, { messageId: t3.userMessageId, inContext: false })
  const t4 = await ask(api, {
    message: 'What word was I told to remember? If none, reply exactly: none',
    sessionId: s,
    space: 'home',
    maxTurns: 3,
  })
  check('a home prompt taken out of context is forgotten too', !has(t4.text, 'DELTA-5'), t4.text)
  void t2
})

// 9 ─ A checkpoint has to outlive a compaction.
//
// The two halves of a rewind are stored apart on purpose: the files in a
// shadow git repo, the conversation in the session DB. Compaction rewrites
// the second and must not touch the first — but "must not" is a claim about
// code nobody had run in that order.
scenario('rewind_after_compact', 2500, async (api) => {
  const cwd = workspace({ 'keep.txt': 'nobody touches this\n' })
  const write = (name, text) =>
    `Use the Write tool to create a file named ${name} in the current directory ` +
    `containing exactly this one line: ${text}. Then reply with only: done`

  const t1 = await ask(api, { message: write('early.txt', 'before the compaction'), cwd, maxTurns: 6 })
  const s = t1.sessionId
  check('the first turn wrote its file and left a checkpoint', read(cwd, 'early.txt') !== null && !!t1.checkpointSha)

  await fill(api, s, cwd, 6)
  const mid = await api.get(`/context/${s}`)
  check(
    'compaction happened in between',
    mid.events.some((e) => e.type === 'compact'),
    { events: mid.events, tokensNow: mid.allTokens },
  )

  put(cwd, 'mine.txt', 'typed by hand, mine\n')
  const t8 = await ask(api, { message: write('late.txt', 'after the compaction'), sessionId: s, cwd, maxTurns: 6 })
  check('and the turn after it still writes and snapshots', read(cwd, 'late.txt') !== null && !!t8.checkpointSha)

  const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
  check('A CHECKPOINT FROM BEFORE THE COMPACTION STILL RESOLVES', r.ok, r)
  check('the file written after it is gone', read(cwd, 'late.txt') === null, read(cwd, 'late.txt'))
  check('the file written before it survives', read(cwd, 'early.txt') !== null)
  check(
    "the user's own file survives",
    read(cwd, 'mine.txt') === 'typed by hand, mine\n',
    read(cwd, 'mine.txt'),
  )
  check(
    'and so does the one nobody touched',
    read(cwd, 'keep.txt') === 'nobody touches this\n',
  )
  discard(cwd)
})

// 10 ─ Home gets the same treatment: compaction, a removed prompt, a rewind.
scenario('home_compact', 2500, async (api, ctx) => {
  const t1 = await ask(api, {
    message: 'Keep this word in mind for later: TANGO-2. Do not use any tools. Reply with only: ok',
    space: 'home',
    maxTurns: 3,
  })
  const s = t1.sessionId
  const box = join(ctx.dataDir, 'sandboxes', s.replace(/[^a-zA-Z0-9_-]/g, '_'))

  const t2 = await ask(api, {
    message: 'Keep this word in mind too: VICTOR-8. Do not use any tools. Reply with only: ok',
    sessionId: s,
    space: 'home',
    maxTurns: 3,
  })
  const off = await api.post(`/context/${s}`, { messageId: t2.userMessageId, inContext: false })
  check('a home prompt can be taken out of context', off.ok && off.changed > 0, off)

  const marked = await ask(api, {
    message:
      'Use the SandboxWrite tool to save a file named before.txt containing exactly: home-before. Then reply with only: done',
    sessionId: s,
    space: 'home',
    maxTurns: 6,
  })
  check('the home turn wrote into the sandbox', read(box, 'before.txt') !== null, box)

  for (let i = 0; i < 6; i++)
    await ask(api, {
      message: `Write about 300 words describing ${SUBJECTS[i % SUBJECTS.length]}. Prose only, no lists.`,
      sessionId: s,
      space: 'home',
      maxTurns: 3,
    })

  const ctx2 = await api.get(`/context/${s}`)
  check(
    'compaction fires in Home too',
    ctx2.events.some((e) => e.type === 'compact'),
    { events: ctx2.events, tokensNow: ctx2.allTokens },
  )
  check(
    'and the removed prompt is still removed',
    ctx2.stored.inContext < ctx2.stored.messages,
    ctx2.stored,
  )

  const t = await ask(api, {
    message: 'Which words was I told to keep in mind? List them, nothing else.',
    sessionId: s,
    space: 'home',
    maxTurns: 3,
  })
  check('the word left in survived the home summary', has(t.text, 'TANGO-2'), t.text)
  check('AND THE REMOVED ONE DID NOT COME BACK', !has(t.text, 'VICTOR-8'), t.text)

  put(box, 'mine.txt', 'the user dropped this in\n')
  await ask(api, {
    message:
      'Use the SandboxWrite tool to save a file named after.txt containing exactly: home-after. Then reply with only: done',
    sessionId: s,
    space: 'home',
    maxTurns: 6,
  })
  const r = await api.post(`/rewind/${s}`, { sha: marked.checkpointSha })
  check('a home rewind still works across a compaction', r.ok, r)
  check('the later file is gone', read(box, 'after.txt') === null, read(box, 'after.txt'))
  check('the earlier one survives', read(box, 'before.txt') !== null)
  check(
    "and the user's own file survives",
    read(box, 'mine.txt') === 'the user dropped this in\n',
    read(box, 'mine.txt'),
  )
})

// 11 ─ A file written from INSIDE the container.
//
// The whole reason the ledger is built from disk rather than from tool
// bookkeeping: a model can write a file with a Python script, and no tool
// reports it. Here the script does not even run on this machine — it runs in
// a container, writing through a mount. If the window around the tool batch
// catches that, it catches anything.
scenario('home_podman', null, async (api, ctx) => {
  if (!existsSync(join(SOURCE_DATA_DIR, 'podman', 'bin', 'podman.exe'))) {
    say('    SKIP  no portable podman in the source data dir')
    return
  }
  const cfg = join(ctx.dataDir, 'sandbox.json')
  writeFileSync(cfg, JSON.stringify({ engine: 'docker' }), 'utf8')
  const python = (name, text) =>
    `Use the RunPython tool to run exactly this, and nothing else:\n` +
    `open("${name}", "w").write("${text}")\n` +
    `Then reply with only: done`

  try {
    const t1 = await ask(api, {
      message: python('by-python.txt', 'written inside the container'),
      space: 'home',
      maxTurns: 6,
    })
    const s = t1.sessionId
    const box = join(ctx.dataDir, 'sandboxes', s.replace(/[^a-zA-Z0-9_-]/g, '_'))
    if (
      !check(
        'the container wrote a file into the sandbox',
        read(box, 'by-python.txt') !== null,
        { box, steps: t1.steps?.slice(-2) },
      )
    )
      return
    check('and the turn still left a checkpoint', !!t1.checkpointSha, t1.checkpointSha)

    put(box, 'mine.txt', 'the user dropped this in\n')

    await ask(api, {
      message: python('also-by-python.txt', 'the second script'),
      sessionId: s,
      space: 'home',
      maxTurns: 6,
    })
    check('the second script wrote its file too', read(box, 'also-by-python.txt') !== null)

    const r = await api.post(`/rewind/${s}`, { sha: t1.checkpointSha })
    check('the rewind succeeds', r.ok, r)
    check(
      'A FILE NO TOOL NAMED IS STILL UNDONE',
      read(box, 'also-by-python.txt') === null,
      read(box, 'also-by-python.txt'),
    )
    check('the first script’s file survives', read(box, 'by-python.txt') !== null)
    check(
      "and the user's own file survives",
      read(box, 'mine.txt') === 'the user dropped this in\n',
      read(box, 'mine.txt'),
    )
  } finally {
    writeFileSync(cfg, JSON.stringify({ engine: 'pyodide' }), 'utf8')
  }
})

// 12 ─ Reconnaissance: the model cannot start coding before it has looked.
//
// The claim is not "it plans better" — that is unmeasurable in one run. It
// is mechanical and checkable: during the first phase the writing tools are
// not in the toolset, so the FIRST thing it does to the folder is a read,
// and the work still happens afterwards.
scenario('recon', null, async (api, ctx) => {
  const cfg = join(ctx.dataDir, 'agent-features.json')
  writeFileSync(cfg, JSON.stringify({ recon: true }), 'utf8')
  const cwd = workspace({
    'notes.md': '# Notes\n\nThe greeting lives in greet.js.\n',
    'greet.js': 'export function greet(name) {\n  return "Hello, " + name;\n}\n',
  })
  try {
    const t = await ask(api, {
      message:
        'Change greet.js so the greeting says "Good evening" instead of "Hello". ' +
        'Reply with only: done',
      cwd,
      maxTurns: 14,
    })
    const calls = (t.steps ?? []).filter((s) => s.type === 'tool').map((s) => s.name)
    const WRITERS = ['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell', 'NotebookEdit']
    const firstWrite = calls.findIndex((n) => WRITERS.includes(n))
    const firstRead = calls.findIndex((n) => ['Read', 'Grep', 'Glob'].includes(n))
    say(`    tools in order: ${calls.join(', ') || '(none)'}`)

    check('it used tools at all', calls.length > 0, calls)
    check('IT READ BEFORE IT WROTE', firstRead >= 0 && (firstWrite < 0 || firstRead < firstWrite), {
      calls,
      firstRead,
      firstWrite,
    })
    check(
      'and the work still happened',
      (read(cwd, 'greet.js') ?? '').includes('Good evening'),
      read(cwd, 'greet.js'),
    )
    check(
      'the file it was not asked about is untouched',
      (read(cwd, 'notes.md') ?? '').includes('The greeting lives in greet.js'),
    )
  } finally {
    writeFileSync(cfg, JSON.stringify({ recon: false }), 'utf8')
    discard(cwd)
  }
})

// 13 ─ A second reader, on a bug a typecheck cannot see.
//
// The change compiles and is wrong: an early return that skips the unlock.
// The verification loop is green on it, which is the whole reason this
// exists — so the measurable claim is that a fresh context reads the diff
// and the run does not end until somebody has looked.
scenario('review', null, async (api, ctx) => {
  const cfg = join(ctx.dataDir, 'agent-features.json')
  writeFileSync(cfg, JSON.stringify({ review: true }), 'utf8')
  const cwd = workspace({
    'lock.js': [
      'let held = false;',
      '',
      'export function withLock(fn) {',
      '  held = true;',
      '  fn();',
      '  held = false;',
      '}',
      '',
      'export function isHeld() {',
      '  return held;',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const t = await ask(api, {
      message:
        'In lock.js, make withLock return early without calling fn when the lock ' +
        'is already held. Use the Edit tool. Reply with only: done',
      cwd,
      maxTurns: 10,
    })
    say(`    lock.js is now:\n${(read(cwd, 'lock.js') ?? '').replace(/^/gm, '      ')}`)
    check('the model made the change', (read(cwd, 'lock.js') ?? '') !== '', read(cwd, 'lock.js'))
    check('and the turn ended cleanly', t.stopReason !== 'error', t.stopReason)

    // The harness says what it did, in its own events — the only evidence
    // that does not require inferring the feature from a side effect.
    const harness = (t.steps ?? []).filter((s) => s.type === 'harness').map((s) => s.text)
    say(`    harness said: ${harness.join(' / ') || '(nothing)'}`)
    check(
      'A SECOND READER ACTUALLY LOOKED',
      harness.some((h) => /second reader/i.test(h)),
      harness,
    )
    check(
      '…and reached a verdict rather than trailing off',
      harness.some((h) => /found (nothing|\d+ thing)|nothing usable/i.test(h)),
      harness,
    )
  } finally {
    writeFileSync(cfg, JSON.stringify({ review: false }), 'utf8')
    discard(cwd)
  }
})

// 14 ─ Asking, before anything is built.
//
// A request with a real fork in it: "make the sessions list collapsible" —
// collapsible groups, or a collapsible panel? Guess wrong and the work is
// wasted. The check is not that it asks THIS question; it is that the
// harness put the question to the user instead of the model guessing.
scenario('clarify', null, async (api, ctx) => {
  const cfg = join(ctx.dataDir, 'agent-features.json')
  writeFileSync(cfg, JSON.stringify({ clarify: true }), 'utf8')
  const cwd = workspace({ 'app.js': 'export const app = 1;\n' })
  try {
    const t = await ask(api, {
      message:
        'Make the sessions list in app.js collapsible. Reply with only: done',
      cwd,
      maxTurns: 6,
      timeout: 180,
    })
    // No renderer is attached to answer a dialog, so the ask times out and
    // the run proceeds — which is the property worth checking: an
    // unanswered question must not hang or kill the turn.
    const harness = (t.steps ?? []).filter((s) => s.type === 'harness').map((s) => s.text)
    say(`    harness said: ${harness.join(' / ') || '(nothing)'}`)
    check(
      'A READER LOOKED AT THE REQUEST BEFORE ANY WORK',
      harness.some((h) => /ambiguous/i.test(h)),
      harness,
    )
    check(
      '…and reached a decision, either way',
      harness.some((h) =>
        /only one way|Asking \d+ question|Nothing usable/i.test(h),
      ),
      harness,
    )
    check('the run finished anyway', t.stopReason !== '', t.stopReason)
    check(
      'AN UNANSWERED QUESTION DOES NOT COST THE TURN',
      (t.steps ?? []).every((s) => s.type !== 'error'),
      (t.steps ?? []).filter((s) => s.type === 'error'),
    )
  } finally {
    writeFileSync(cfg, JSON.stringify({ clarify: false }), 'utf8')
    discard(cwd)
  }
})

// ─── Runner ─────────────────────────────────────────────────────────────

if (!existsSync(MAIN)) {
  console.log('SKIP  out/main/index.js is missing — run `npm run build` first')
  process.exit(0)
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const todo = wanted.length
  ? scenarios.filter((s) => wanted.includes(s.name))
  : scenarios
if (!todo.length) {
  console.error(`no such scenario. known: ${scenarios.map((s) => s.name).join(', ')}`)
  process.exit(2)
}

// One app per compaction threshold: MONET_COMPACT_TOKENS is read once, when
// the module loads, so it cannot be changed under a running app.
const groups = new Map()
for (const s of todo) {
  const key = String(s.compactTokens ?? '')
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(s)
}

for (const [key, list] of groups) {
  const env = key ? { MONET_COMPACT_TOKENS: key } : {}
  say(`\n=== booting the app${key ? ` (compaction at ${key} tokens)` : ''} …`)
  let app
  try {
    app = await bootApp(env)
  } catch (err) {
    check(`the app boots${key ? ` with MONET_COMPACT_TOKENS=${key}` : ''}`, false, err.message)
    continue
  }
  say(`    data dir: ${app.dataDir}`)
  for (const s of list) {
    say(`\n--- ${s.name}`)
    try {
      await s.run(app.api, app)
    } catch (err) {
      check(`${s.name} runs to the end`, false, err.message)
    }
  }
  app.child.kill()
  await sleep(500)
  try {
    rmSync(app.dataDir, { recursive: true, force: true })
  } catch {
    /* the app may still hold the DB open — a temp dir is no great loss */
  }
}

say('')
if (failures) {
  say(`${failures} of ${checks} checks FAILED:`)
  for (const n of failedNames) say(`  · ${n}`)
} else {
  say(`ALL ${checks} LIVE CHECKS PASSED`)
}
process.exit(failures ? 1 : 0)

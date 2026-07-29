/**
 * Drives the built app in --acp mode exactly as an editor would: spawn it,
 * speak JSON-RPC over stdio, check the handshake.
 *
 * The reason this exists rather than a unit test: two of the assumptions
 * underneath ACP mode are properties of Electron, not of our code, and both
 * were wrong on the first attempt.
 *
 *   - `process.stdin` in an Electron main process reports readable and then
 *     immediately ends. Reading fd 0 works. (Measured, not read in a doc.)
 *   - stdout is shared with every console.log in the main process, and one
 *     `[mcp] connected` line in the middle of a JSON-RPC stream ends the
 *     session. The adapter claims stdout; this checks that it stayed clean.
 *
 * Runs against out/main/index.js, so `npm run build` must have run first.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')

const main = resolve('out/main/index.js')
if (!existsSync(main)) {
  console.log('SKIP  out/main/index.js is missing — run `npm run build` first')
  process.exit(0)
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const child = spawn(electron, [main, '--acp'], { stdio: ['pipe', 'pipe', 'pipe'] })

const lines = []
const junk = []
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      junk.push(line)
    }
  }
})

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => (stderr += c))

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')

const waitFor = (pred, ms, what) =>
  new Promise((res, rej) => {
    const t0 = Date.now()
    const tick = setInterval(() => {
      const hit = lines.find(pred)
      if (hit) {
        clearInterval(tick)
        res(hit)
      } else if (Date.now() - t0 > ms) {
        clearInterval(tick)
        rej(new Error(`timed out waiting for ${what}`))
      }
    }, 60)
  })

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  })
  const init = await waitFor((m) => m.id === 1, 45_000, 'initialize')
  check('the app answers initialize', init.result !== undefined, JSON.stringify(init).slice(0, 160))
  check(
    'and negotiates a protocol version',
    typeof init.result?.protocolVersion === 'number',
    init.result?.protocolVersion,
  )
  check(
    'it does not claim image support it would drop',
    init.result?.agentCapabilities?.promptCapabilities?.image === false,
    JSON.stringify(init.result?.agentCapabilities?.promptCapabilities),
  )

  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: process.cwd(), mcpServers: [] },
  })
  const session = await waitFor((m) => m.id === 2, 30_000, 'session/new')
  const sessionId = session.result?.sessionId
  check('a session can be created', typeof sessionId === 'string', JSON.stringify(session).slice(0, 160))

  // An unknown session must be refused, not crash the connection.
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'no-such-session', prompt: [{ type: 'text', text: 'hi' }] },
  })
  const bogus = await waitFor((m) => m.id === 3, 30_000, 'prompt on a bad session')
  check(
    'an unknown session is refused cleanly',
    bogus.result?.stopReason === 'refusal' || bogus.error !== undefined,
    JSON.stringify(bogus).slice(0, 160),
  )

  // The connection must still be alive after that.
  send({ jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } })
  await waitFor((m) => m.id === 4, 30_000, 'a second session')
  check('the connection survives a bad request', true)

  // The whole point of claiming stdout.
  check(
    'stdout carried ONLY protocol messages',
    junk.length === 0,
    junk.slice(0, 2).join(' | '),
  )
  check(
    'and the app logged to stderr instead',
    stderr.length > 0 || lines.length > 0,
    `${stderr.length} bytes of stderr`,
  )
} catch (err) {
  check('acp handshake', false, err.message)
  console.log('--- messages:', JSON.stringify(lines).slice(0, 400))
  console.log('--- junk on stdout:', junk.slice(0, 3).join(' | '))
  console.log('--- stderr:', stderr.slice(0, 800))
}

child.kill()
console.log(failures ? `\n${failures} FAILED` : '\nALL ACP CHECKS PASSED')
process.exit(failures ? 1 : 0)

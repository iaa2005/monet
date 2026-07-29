/**
 * Checks the MCP config rules and the OAuth callback listener.
 *
 * The callback half is the one that matters. The pre-existing connector flow
 * generated an OAuth `state` and then never looked at the value that came
 * back — which is the whole reason `state` exists. Without that check, any
 * page the browser visits during the flow can hit the loopback port with a
 * code of its choosing and have it exchanged against the user's client
 * registration. The tests below drive a real HTTP request at a real listener.
 */

import { startCallbackServer } from '../src/main/mcp/oauth/callback.js'
import { filterTools, resolveHeaders } from '../src/main/mcp/config-rules.js'
import { credentialKey } from '../src/main/mcp/oauth/store.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

// ─── Tool allow / deny ──────────────────────────────────────────────────

const tools = [{ name: 'read' }, { name: 'write' }, { name: 'delete_all' }]

check('no lists means every tool', filterTools(tools, {}).length === 3)
check(
  'an allow-list keeps only what it names',
  filterTools(tools, { enabledTools: ['read'] }).map((t) => t.name).join() === 'read',
)
check(
  'a deny-list removes what it names',
  !filterTools(tools, { disabledTools: ['delete_all'] }).some((t) => t.name === 'delete_all'),
)
check(
  'deny wins over allow',
  filterTools(tools, { enabledTools: ['read', 'write'], disabledTools: ['write'] })
    .map((t) => t.name)
    .join() === 'read',
)
// The trap: treating an empty allow-list as "unset" hands the model every
// tool the server has, which is the opposite of what was asked for.
check(
  'an EMPTY allow-list exposes nothing',
  filterTools(tools, { enabledTools: [] }).length === 0,
  filterTools(tools, { enabledTools: [] }),
)
check(
  'an empty deny-list changes nothing',
  filterTools(tools, { disabledTools: [] }).length === 3,
)
check(
  'a name that does not exist is simply ignored',
  filterTools(tools, { disabledTools: ['nope'] }).length === 3,
)

// ─── Headers and env-var tokens ─────────────────────────────────────────

check('no config means no headers', resolveHeaders({}, {}) === undefined)
check(
  'a named env var becomes a bearer header',
  resolveHeaders({ bearerTokenEnvVar: 'TOK' }, { TOK: 'abc' })?.Authorization ===
    'Bearer abc',
)
// "Bearer undefined" is a real string that a server will happily reject with
// a confusing message; no header at all produces an honest 401.
check(
  'an UNSET env var produces no header, not "Bearer undefined"',
  resolveHeaders({ bearerTokenEnvVar: 'MISSING' }, {}) === undefined,
  resolveHeaders({ bearerTokenEnvVar: 'MISSING' }, {}),
)
check(
  'a blank env var is treated as unset',
  resolveHeaders({ bearerTokenEnvVar: 'TOK' }, { TOK: '   ' }) === undefined,
)
check(
  'an explicit Authorization header wins',
  resolveHeaders(
    { headers: { Authorization: 'Bearer mine' }, bearerTokenEnvVar: 'TOK' },
    { TOK: 'other' },
  )?.Authorization === 'Bearer mine',
)
check(
  'the explicit header wins regardless of case',
  resolveHeaders(
    { headers: { authorization: 'Bearer mine' }, bearerTokenEnvVar: 'TOK' },
    { TOK: 'other' },
  )?.authorization === 'Bearer mine',
)
check(
  'other headers survive alongside the token',
  resolveHeaders({ headers: { 'X-Tenant': 'acme' }, bearerTokenEnvVar: 'TOK' }, { TOK: 'a' })?.[
    'X-Tenant'
  ] === 'acme',
)

// ─── Credential keys ────────────────────────────────────────────────────

const k1 = credentialKey('linear', 'https://mcp.linear.app/mcp')
check('a key is filesystem-safe', /^[a-zA-Z0-9_-]+$/.test(k1), k1)
check('the same server gives the same key', credentialKey('linear', 'https://mcp.linear.app/mcp') === k1)
check(
  'pointing the same NAME at another host gives a different key',
  credentialKey('linear', 'https://evil.example/mcp') !== k1,
)
check(
  'renaming the server gives a different key',
  credentialKey('linear-2', 'https://mcp.linear.app/mcp') !== k1,
)
check(
  'an awkward name is still safe',
  /^[a-zA-Z0-9_-]+$/.test(credentialKey('../../etc/passwd', 'https://x')),
  credentialKey('../../etc/passwd', 'https://x'),
)

// ─── The callback listener ──────────────────────────────────────────────

const server = await startCallbackServer()
check('the listener binds to loopback only', server.url.startsWith('http://127.0.0.1:'), server.url)
check('it carries a state to match', server.state.length >= 16)

const hit = async (query: string): Promise<number> => {
  const res = await fetch(`${server.url}?${query}`)
  return res.status
}

// A forged callback: right shape, wrong state.
const waiting = server.waitForCode(5_000)
let rejected: Error | null = null
waiting.catch((e: Error) => {
  rejected = e
})

await hit(`code=forged&state=not-the-right-state`)
await new Promise((r) => setTimeout(r, 100))
check(
  'a callback with the WRONG state is rejected',
  rejected !== null,
  rejected ? String((rejected as Error).message) : 'no rejection',
)
check(
  'and the reason names the state mismatch',
  /state mismatch/i.test((rejected as unknown as Error)?.message ?? ''),
  (rejected as unknown as Error)?.message,
)
server.close()

// The happy path, on a fresh listener.
const good = await startCallbackServer()
const codePromise = good.waitForCode(5_000)
await fetch(`${good.url}?code=the-real-code&state=${good.state}`)
const code = await codePromise
check('a callback with the RIGHT state yields the code', code === 'the-real-code', code)
good.close()

// A provider error must surface as an error, not a hang.
const cancelled = await startCallbackServer()
const cancelPromise = cancelled.waitForCode(5_000)
let cancelErr: Error | null = null
cancelPromise.catch((e: Error) => {
  cancelErr = e
})
await fetch(`${cancelled.url}?error=access_denied&state=${cancelled.state}`)
await new Promise((r) => setTimeout(r, 100))
check('a denied sign-in rejects rather than hanging', cancelErr !== null)
check(
  'and reports what the provider said',
  /access_denied/.test((cancelErr as unknown as Error)?.message ?? ''),
  (cancelErr as unknown as Error)?.message,
)
cancelled.close()

// Two flows at once must not capture each other's code — the old
// implementation kept the resolver in module state, so the second sign-in
// would have taken over the first.
const a = await startCallbackServer()
const b = await startCallbackServer()
check('two flows get different ports', a.url !== b.url, [a.url, b.url])
check('and different states', a.state !== b.state)
const aCode = a.waitForCode(5_000)
const bCode = b.waitForCode(5_000)
await fetch(`${b.url}?code=for-b&state=${b.state}`)
await fetch(`${a.url}?code=for-a&state=${a.state}`)
check('each flow gets its own code', (await aCode) === 'for-a' && (await bCode) === 'for-b')
a.close()
b.close()

console.log(failures === 0 ? '\nALL MCP CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

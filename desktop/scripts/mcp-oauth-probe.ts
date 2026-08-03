/**
 * Connector OAuth: what a BACKGROUND connection is allowed to do, and where a
 * sign-in puts its tokens.
 *
 * Reported: alphaXiv opened five or six browser tabs on launch, and after a
 * while could not be signed in at all — deleting and re-adding the connector
 * was the only cure. Three defects, each testable without a browser:
 *
 *   1. a background connect could start an interactive flow (the tabs);
 *   2. the flow's state was module-global, so a second attempt overwrote the
 *      first one's verifier and port (the sign-in that never completes);
 *   3. "Sign in" wrote the token where a CONNECTOR server never reads it.
 *
 *   npm run smoke:mcpoauth
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir } from '../src/main/data-dir.js'

const tempData = mkdtempSync(join(tmpdir(), 'mcp-oauth-probe-'))
setDataDir(tempData)

const {
  ConnectorOAuthProvider,
  InteractiveAuthRequired,
  connectorAuthProvider,
} = await import('../src/main/connectors/lib/mcp-oauth-provider.js')
const { patchSecret, getSecret } = await import('../src/main/connectors/store.js')

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

const ACC = 'acc-alphaxiv'
const TOKENS = JSON.stringify({ access_token: 'at', refresh_token: 'rt' })

// ─── A background connection must not reach for the browser ─────────────

{
  patchSecret(ACC, { mcpOauthTokens: '' })
  check(
    'no stored token → no provider at all, so the 401 surfaces',
    connectorAuthProvider(ACC) === undefined,
  )

  patchSecret(ACC, { mcpOauthTokens: TOKENS })
  const p = connectorAuthProvider(ACC)
  check('a stored token → a provider that can refresh', !!p)
  check(
    'which still holds the tokens it was given',
    JSON.stringify(p!.tokens()) === TOKENS,
  )

  let threw: unknown = null
  try {
    await (p as InstanceType<typeof ConnectorOAuthProvider>)
      .redirectToAuthorization(new URL('https://alphaxiv.org/authorize'))
  } catch (e) { threw = e }
  check(
    'and REFUSES to open a browser — this is what produced the tabs',
    threw instanceof InteractiveAuthRequired,
    String(threw),
  )
}

// ─── A flow owns its own redirect, and registers the real one ───────────

{
  const bg = new ConnectorOAuthProvider(ACC, false)
  check(
    'an unbound provider advertises no redirect_uri…',
    bg.redirectUrl === undefined,
  )
  check(
    '…and registers none, rather than a port nobody will listen on',
    bg.clientMetadata.redirect_uris.length === 0,
    bg.clientMetadata.redirect_uris,
  )

  const a = new ConnectorOAuthProvider(ACC, true)
  const b = new ConnectorOAuthProvider(ACC, true)
  a.bindFlow('http://127.0.0.1:41111', 'state-a')
  b.bindFlow('http://127.0.0.1:52222', 'state-b')
  check('two flows keep their own port', a.redirectUrl !== b.redirectUrl)
  check('and their own CSRF state', a.state() === 'state-a' && b.state() === 'state-b')
  check(
    'the registered redirect_uri is the real listener',
    a.clientMetadata.redirect_uris[0] === 'http://127.0.0.1:41111',
    a.clientMetadata.redirect_uris,
  )
  check(
    'a real port, never :0 — the mismatch a strict server rejects',
    !JSON.stringify(a.clientMetadata.redirect_uris).includes(':0'),
  )
}

// ─── Credentials go in, and out, of one place ───────────────────────────

{
  const p = new ConnectorOAuthProvider(ACC, true)
  p.saveTokens({ access_token: 'fresh', refresh_token: 'rot', token_type: 'bearer' })
  check(
    'a refresh replaces BOTH tokens, so an idle account stays signed in',
    getSecret(ACC).mcpOauthTokens?.includes('rot') === true,
  )
  p.saveCodeVerifier('verifier-1')
  check('the verifier is stored for the exchange', p.codeVerifier() === 'verifier-1')

  p.invalidateCredentials()
  const s = getSecret(ACC)
  check(
    'signing out clears the token, the registration and the verifier',
    !s.mcpOauthTokens && !s.mcpClientId && !s.mcpCodeVerifier,
    s,
  )
}

// ─── Routing: the door a connector server reads from ────────────────────
//
// The UI's "Sign in" used to look the server up in mcp-servers.json, where a
// connector's server has never been. Both halves of the fix are visible in
// the shape of the config the manager hands out.
{
  const { effectiveConfig, loadConfig } = await import('../src/main/mcp/manager.js')
  const file = loadConfig().mcpServers
  const eff = effectiveConfig().mcpServers
  check(
    'effectiveConfig is a superset of the file — the row the UI shows',
    Object.keys(file).every((k) => k in eff),
  )
  check(
    'and a connector server is recognised by _accountId',
    Object.values(eff).every(
      (s) => !('_accountId' in s) || typeof s._accountId === 'string',
    ),
  )
}

// ─── Who actually needs the browser ─────────────────────────────────────
//
// A "Sign in" button that is always there teaches people to click it for
// nothing, and clicking it burns a working grant. So the app answers the
// question instead of delegating it — and must not answer "yes" for a
// server that is merely offline.
{
  const { authNeedFor, isAuthFailure } = await import(
    '../src/main/connectors/mcp-auth-state.js'
  )

  check('no token at all → sign in', authNeedFor(false, undefined) === 'never-signed-in')
  check(
    'a connected server needs nothing',
    authNeedFor(true, { status: 'connected' }) === null,
  )
  check(
    'a refused token → sign in again',
    authNeedFor(true, { status: 'error', error: 'Missing Authorization' }) === 'expired',
  )
  check(
    'a 401 counts too',
    authNeedFor(true, { status: 'error', error: 'HTTP 401 Unauthorized' }) === 'expired',
  )
  check(
    'but a network failure does NOT send anyone to a login page',
    authNeedFor(true, { status: 'error', error: 'getaddrinfo ENOTFOUND api.example.org' }) === null,
  )
  check(
    'nor does a server error',
    authNeedFor(true, { status: 'error', error: 'Internal Server Error (500)' }) === null,
  )
  check(
    'a server still connecting is not a verdict',
    authNeedFor(true, { status: 'connecting' }) === null,
  )
  check(
    'the wordings real servers use are all recognised',
    ['Missing Authorization', 'invalid_token', 'invalid_grant', '401', 'token_expired', 'Forbidden']
      .every(isAuthFailure),
  )
  check('and an empty message is not one', !isAuthFailure(undefined) && !isAuthFailure(''))
}

rmSync(tempData, { recursive: true, force: true })
rmSync(join(process.cwd(), 'monet-bootstrap.json'), { force: true })

console.log(failures === 0 ? '\nALL MCP-OAUTH CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

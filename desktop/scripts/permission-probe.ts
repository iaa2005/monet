/**
 * Checks the permission pipeline: which stage decides, and what it decides.
 *
 * The regression this pins down is the one that shipped once already — auto
 * mode allowed Edit and Write BY NAME, and since a path outside the workspace
 * only ever produces "ask" (never "deny"), the agent could write anywhere on
 * disk. A name-list check would pass a test that only asked "is Edit allowed
 * in auto mode?", so the tests below assert on the DECIDING STAGE, not just
 * the outcome: an edit inside the workspace must be allowed by
 * auto-mode-accept-edits (which consults the tool's own path scoping), never
 * by auto-mode-approve (the name list).
 *
 * The tools are stubs. The point is the ordering of the pipeline, and a stub
 * lets a test say "this tool's own rules would say ask" without a filesystem.
 */

import {
  decidePermission,
  pathArgs,
  type PolicyContext,
} from '../src/main/agent/permission-policies.js'
import type { Tool, ToolUseContext } from '../src/vendor/leaked/Tool.js'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}`)
    if (detail !== undefined) console.log('      ', JSON.stringify(detail))
  }
}

type Behaviour = 'allow' | 'deny' | 'ask'

/** A tool whose own checkPermissions answers however the test wants — and
 * differently when probed as acceptEdits, which is how the real path scoping
 * behaves for a file inside the workspace. */
function stubTool(opts: {
  name: string
  readOnly?: boolean
  own?: Behaviour
  /** What checkPermissions says when asked as if in acceptEdits mode. */
  asAcceptEdits?: Behaviour
}): Tool {
  return {
    name: opts.name,
    isReadOnly: () => opts.readOnly === true,
    userFacingName: () => opts.name,
    checkPermissions: async (_input: unknown, ctx: ToolUseContext) => {
      const mode = ctx.getAppState().toolPermissionContext.mode
      const b = mode === 'acceptEdits' ? (opts.asAcceptEdits ?? opts.own ?? 'ask') : (opts.own ?? 'ask')
      return b === 'allow'
        ? { behavior: 'allow' as const, updatedInput: undefined }
        : b === 'deny'
          ? { behavior: 'deny' as const, message: 'rule says no' }
          : { behavior: 'ask' as const, message: 'needs approval' }
    },
  } as unknown as Tool
}

function ctxFor(over: Partial<PolicyContext> & { tool: Tool }): PolicyContext {
  // `??` cannot tell "not provided" from "explicitly undefined", and the
  // no-prompt-channel cases need exactly that distinction — so the key's
  // PRESENCE decides, not its value.
  const hasChannel = !('requestPermission' in over) || over.requestPermission
  return {
    tool: over.tool,
    input: over.input ?? {},
    permissionMode: over.permissionMode ?? 'default',
    sessionId: over.sessionId ?? 's1',
    grants: over.grants ?? new Set<string>(),
    // Absent by default: most cases have nothing to do with the browser, and
    // the stage must have no opinion when it is not told anything.
    browser: over.browser,
    requestPermission: hasChannel
      ? (over.requestPermission ?? (async () => 'allow-once'))
      : undefined,
    context: {
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    } as unknown as ToolUseContext,
  }
}

// ─── pathArgs ───────────────────────────────────────────────────────────

check('pathArgs reads file_path', pathArgs({ file_path: '/a/.env' })[0] === '/a/.env')
check('pathArgs reads path', pathArgs({ path: '/a/b' })[0] === '/a/b')
check(
  'pathArgs walks an edits[] batch',
  pathArgs({ edits: [{ file_path: '/x' }, { file_path: '/y' }] }).length === 2,
)
check('pathArgs ignores non-strings', pathArgs({ file_path: 42 }).length === 0)

// ─── Ordering ───────────────────────────────────────────────────────────

const bash = stubTool({ name: 'Bash' })
const read = stubTool({ name: 'Read', readOnly: true })

let r = await decidePermission(
  ctxFor({ tool: bash, permissionMode: 'bypassPermissions' }),
)
check('bypass decides first', r.decidedBy === 'bypass-mode-approve', r)
check('bypass allows', r.decision.behavior === 'allow')

r = await decidePermission(ctxFor({ tool: bash, permissionMode: 'plan' }))
check('plan mode blocks a writing tool', r.decision.behavior === 'deny', r)
check('and says which stage', r.decidedBy === 'plan-mode-guard')

r = await decidePermission(ctxFor({ tool: read, permissionMode: 'plan' }))
check('plan mode allows a read-only tool', r.decision.behavior === 'allow')

// Plan mode must outrank a grant given in another mode.
r = await decidePermission(
  ctxFor({
    tool: bash,
    permissionMode: 'plan',
    grants: new Set(['s1:Bash']),
  }),
)
check(
  'a session grant does NOT get past plan mode',
  r.decision.behavior === 'deny' && r.decidedBy === 'plan-mode-guard',
  r,
)

r = await decidePermission(
  ctxFor({ tool: bash, grants: new Set(['s1:Bash']) }),
)
check(
  'an "allow always" grant short-circuits',
  r.decision.behavior === 'allow' && r.decidedBy === 'session-approval-history',
  r,
)

r = await decidePermission(ctxFor({ tool: stubTool({ name: 'X', own: 'deny' }) }))
check(
  "a tool's own deny is final",
  r.decision.behavior === 'deny' && r.decidedBy === 'tool-own-rules',
  r,
)

// ─── Auto mode: the regression ──────────────────────────────────────────

// An edit INSIDE the workspace: the tool's own rules say ask, but the same
// check as acceptEdits says allow. Must be allowed — by the scoped stage.
const editInside = stubTool({ name: 'Edit', own: 'ask', asAcceptEdits: 'allow' })
r = await decidePermission(
  ctxFor({ tool: editInside, permissionMode: 'auto', input: { file_path: '/ws/a.ts' } }),
)
check('auto allows an in-workspace edit', r.decision.behavior === 'allow', r)
check(
  'and does it via the path-scoped stage, not a name list',
  r.decidedBy === 'auto-mode-accept-edits',
  r.decidedBy,
)

// An edit OUTSIDE the workspace: acceptEdits also says ask. Must reach the
// user, not be allowed. This is the bug.
const editOutside = stubTool({ name: 'Edit', own: 'ask', asAcceptEdits: 'ask' })
let promptedWith: string | undefined
r = await decidePermission(
  ctxFor({
    tool: editOutside,
    permissionMode: 'auto',
    input: { file_path: 'C:/Windows/System32/drivers/etc/hosts' },
    requestPermission: async (a) => {
      promptedWith = a.detail
      return 'deny'
    },
  }),
)
check(
  'auto does NOT silently allow an edit outside the workspace',
  r.decision.behavior === 'deny',
  r,
)
check('it reached the user first', promptedWith?.includes('System32') === true, promptedWith)
check('via the fallback stage', r.decidedBy === 'fallback-ask', r.decidedBy)

r = await decidePermission(ctxFor({ tool: read, permissionMode: 'auto' }))
check(
  'auto allows read-only tools by name list',
  r.decision.behavior === 'allow' && r.decidedBy === 'auto-mode-approve',
  r,
)

// ─── Sensitive files ────────────────────────────────────────────────────

let sensitivePrompt: string | undefined
r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/.env' },
    requestPermission: async (a) => {
      sensitivePrompt = a.detail
      return 'deny'
    },
  }),
)
check(
  'auto mode does NOT silently read .env',
  r.decision.behavior === 'deny',
  r,
)
check('the prompt names the file', sensitivePrompt === '/ws/.env', sensitivePrompt)
check('decided by the sensitive stage', r.decidedBy === 'sensitive-file-ask')

// Approving is per-path, and only for this session.
const grants = new Set<string>()
r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/.env' },
    grants,
    requestPermission: async () => 'allow',
  }),
)
check('approving a secret lets the call proceed', r.decision.behavior === 'allow', r)
check('the grant is recorded per path', grants.has('s1:sensitive:/ws/.env'), [...grants])

let askedAgain = false
r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/.env' },
    grants,
    requestPermission: async () => {
      askedAgain = true
      return 'deny'
    },
  }),
)
check('the same file is not asked about twice', !askedAgain && r.decision.behavior === 'allow')

let askedOther = false
await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/id_rsa' },
    grants,
    requestPermission: async () => {
      askedOther = true
      return 'deny'
    },
  }),
)
check('a DIFFERENT secret still asks', askedOther)

// An ordinary file must not be dragged into the sensitive path.
let askedOrdinary = false
r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/src/env.ts' },
    requestPermission: async () => {
      askedOrdinary = true
      return 'deny'
    },
  }),
)
check(
  'an ordinary file is untouched by the sensitive stage',
  !askedOrdinary && r.decision.behavior === 'allow',
  r,
)

// Explicit "skip all approvals" still skips — the user turned the gate off.
r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'bypassPermissions',
    input: { file_path: '/ws/.env' },
    requestPermission: async () => 'deny',
  }),
)
check('bypass mode still bypasses a secret', r.decision.behavior === 'allow', r)

// ─── No prompt channel ──────────────────────────────────────────────────

r = await decidePermission(
  ctxFor({ tool: bash, requestPermission: undefined }),
)
check(
  'with nobody to ask, an unapproved tool is refused',
  r.decision.behavior === 'deny' && r.decidedBy === 'fallback-ask',
  r,
)

r = await decidePermission(
  ctxFor({
    tool: read,
    permissionMode: 'auto',
    input: { file_path: '/ws/.env' },
    requestPermission: undefined,
  }),
)
check(
  'an unattended run refuses a secret rather than reading it',
  r.decision.behavior === 'deny' && r.decidedBy === 'sensitive-file-ask',
  r,
)

// ─── Browser origins ────────────────────────────────────────────────────
//
// The trade this stage makes: localhost runs silently because the cycle of
// change-a-style, reload, look happens twenty times an hour and a prompt each
// time trains people to approve without reading. Everything else asks. The
// cases below are the ones where getting it backwards is invisible — acting on
// a page that has LEFT an allowed origin, and running JavaScript.

const nav = stubTool({ name: 'BrowserNavigate' })
const clickTool = stubTool({ name: 'BrowserClick' })
const readPage = stubTool({ name: 'BrowserReadPage', readOnly: true })
const evalTool = stubTool({ name: 'BrowserEval' })

const browserCtx = (over: {
  approval?: 'manual' | 'allowlist' | 'auto'
  allowedOrigins?: string[]
  currentUrl?: string | null
}) => ({
  approval: over.approval ?? ('allowlist' as const),
  allowedOrigins: over.allowedOrigins ?? [],
  currentUrl: over.currentUrl ?? null,
})

r = await decidePermission(
  ctxFor({
    tool: nav,
    input: { url: 'http://localhost:5173/' },
    browser: browserCtx({}),
  }),
)
check(
  'navigating to localhost never asks',
  r.decision.behavior === 'allow' && r.decidedBy === 'browser-origin',
  r,
)

r = await decidePermission(
  ctxFor({ tool: nav, input: { url: 'https://example.com' }, browser: browserCtx({}) }),
)
check('navigating anywhere else asks', r.decidedBy === 'fallback-ask', r)

r = await decidePermission(
  ctxFor({
    tool: nav,
    input: { url: 'https://acme.dev/app' },
    browser: browserCtx({ allowedOrigins: ['https://acme.dev'] }),
  }),
)
check('an allow-listed site does not ask', r.decidedBy === 'browser-origin', r)

// Acting is judged by where the page IS. Following a link off an allowed site
// must put the prompts back — otherwise one approved navigation licenses every
// click that follows, anywhere it leads.
r = await decidePermission(
  ctxFor({
    tool: clickTool,
    browser: browserCtx({
      allowedOrigins: ['https://acme.dev'],
      currentUrl: 'https://tracker.evil/landing',
    }),
  }),
)
check('clicking after leaving an allowed origin asks again', r.decidedBy === 'fallback-ask', r)

r = await decidePermission(
  ctxFor({
    tool: clickTool,
    browser: browserCtx({
      allowedOrigins: ['https://acme.dev'],
      currentUrl: 'https://acme.dev/app',
    }),
  }),
)
check('clicking on the allowed page does not', r.decidedBy === 'browser-origin', r)

r = await decidePermission(
  ctxFor({ tool: readPage, browser: browserCtx({ currentUrl: 'https://example.com' }) }),
)
check(
  'reading a page never asks, wherever it is',
  r.decision.behavior === 'allow' && r.decidedBy === 'browser-origin',
  r,
)

r = await decidePermission(
  ctxFor({
    tool: evalTool,
    input: { javascript: 'document.title' },
    browser: browserCtx({ currentUrl: 'http://localhost:5173/' }),
  }),
)
check('running JavaScript asks even on localhost', r.decidedBy === 'fallback-ask', r)

r = await decidePermission(
  ctxFor({
    tool: nav,
    input: { url: 'http://localhost:5173/' },
    browser: browserCtx({ approval: 'manual' }),
  }),
)
check('"ask about everything" means localhost too', r.decidedBy === 'fallback-ask', r)

r = await decidePermission(
  ctxFor({
    tool: evalTool,
    input: { javascript: 'fetch("/admin/delete")' },
    browser: browserCtx({ approval: 'auto', currentUrl: 'https://example.com' }),
  }),
)
check('"never ask" means never', r.decidedBy === 'browser-origin', r)

// A non-browser tool must not be touched by any of this.
r = await decidePermission(
  ctxFor({ tool: bash, browser: browserCtx({ approval: 'auto' }) }),
)
check('the browser stage ignores other tools', r.decidedBy !== 'browser-origin', r)

// Without browser facts the stage has no opinion — it cannot invent one.
r = await decidePermission(ctxFor({ tool: nav, input: { url: 'http://localhost:3000' } }))
check('no browser context means no browser decision', r.decidedBy !== 'browser-origin', r)

console.log(failures === 0 ? '\nALL PERMISSION CHECKS PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

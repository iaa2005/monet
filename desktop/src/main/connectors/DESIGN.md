# Connectors v2 — design

Status: **plan** (agreed direction; implementation phased below).
Companion to [services/README.md](services/README.md), which stays the how-to
for writing one service; this file is the architecture: folders, permissions,
the file-exchange protocol, and how it all meets the agent and routines.

---

## 1. What stays true from v1

These rules survived contact with reality and do not change:

- **One folder = one service.** Everything about an integration lives in its
  folder; the only outside touch-point is a registry entry.
- **Service `id` is forever.** `accounts.json` rows reference it; folder moves
  are free, ids are not. `gmail`, `yandex-disk`, `telegram`, … all keep their
  current ids through the restructure.
- **Secrets** stay in `store.ts` — safeStorage-encrypted, separate file,
  never sent to the renderer, trim-on-write-only.
- **`test` is type-required.** A service that cannot prove its credential is a
  service that shows false green.
- **The renderer is dumb.** Forms, setup steps, and (new) permission matrices
  render from *data* the service declares. No per-service React components —
  14 bespoke forms is 14 places to break.
- **Verification rules** from README (never guess endpoints, quote the server,
  `npm view` before shipping a package name) apply to every new capability.

## 2. Folder restructure — company folders

### Target tree

```
src/main/connectors/
  index.ts                  # resolveAccount / accountsWithCapability / pickAccount
  store.ts                  # accounts + encrypted secrets (+ NEW: permission overrides)
  types.ts                  # ConnectorAccount/Secret/ProtocolResult (unchanged)
  DESIGN.md                 # this file
  lib/                      # ONLY cross-company code:
    protocols/              #   open standards used by 2+ companies
      mail.ts               #   IMAP/SMTP  (imapflow + nodemailer)   ← was lib/mail.ts
      dav.ts                #   CalDAV/CardDAV (tsdav)               ← was lib/dav.ts
      webdav.ts             #   WebDAV                               ← was lib/files.ts
    file-bridge.ts          #   NEW: sandbox/workdir file exchange (§4)
    permissions.ts          #   NEW: action permission engine (§3)
  services/
    types.ts                # the ConnectorService contract (+ actions, + ctx)
    registry.ts             # spreads company registries; the ONE shared list
    README.md
    google/
      index.ts              # export const googleServices = [gmail, drive, …]
      auth.ts               # ← was oauth/google.ts (googleSignIn, googleAccessToken)
      setup.ts              # ← was services/google-setup.ts
      gmail/     index.ts + icon.svg
      drive/     index.ts + icon.svg + api.ts   ← was lib/gdrive.ts
      calendar/  index.ts + icon.svg
      contacts/  index.ts + icon.svg + api.ts   ← was lib/gpeople.ts
    yandex/
      index.ts   # export const yandexServices = […]
      setup.ts   # ← was services/yandex-setup.ts (incl. yandexAuthHint)
      mail/ disk/ calendar/ contacts/
    telegram/
      index.ts   # export const telegramServices = [account, bot]
      mtproto.ts # ← was lib/telegram.ts (session, client, resolveUpload→bridge)
      account/   # current "telegram" service (id unchanged!)
      bot/       # NEW service "telegram-bot" (§6)
    github/    index.ts + service folder
    slack/     …
    notion/ linear/ sentry/  (single-service "companies" — same shape, one entry)
```

### The import rule that makes folders independent

> **A company folder may import from `lib/` and from itself — never from
> another company folder.** `lib/` may not import from any company folder.

That is the whole modularity contract. Deleting `yandex/` can break nothing in
`google/`; deleting a product folder breaks only its line in the company index.

### Why `mail.ts` / `dav.ts` / `webdav.ts` do NOT move into company folders

They are **open protocols**, not company APIs: Gmail-IMAP *and* Yandex-IMAP use
`protocols/mail.ts`; Google-CalDAV *and* Yandex-CalDAV use `protocols/dav.ts`.
Moving IMAP into `google/gmail/` would force `yandex/mail/` to import from
`google/` — exactly the coupling the restructure is meant to kill. The line is:

| goes in `lib/protocols/` | goes in the company folder |
|---|---|
| open standard, 2+ companies speak it (IMAP, SMTP, CalDAV, CardDAV, WebDAV) | proprietary API only that company has (Drive REST, People API, MTProto, Bot API, GitHub REST) |

`gdrive.ts`, `gpeople.ts`, `telegram.ts` were misfiled in v1 — they move.

### Registry math (the "2–3 lines" promise, kept)

- add a **service**: its folder + 1 line in the company `index.ts`
- add a **company**: its folder + 1 line in `registry.ts`
- delete either: remove the folder + its single line

`registry.ts` becomes:

```ts
export const SERVICES: ConnectorService[] = [
  ...googleServices, ...yandexServices, ...telegramServices,
  github, slack, notion, linear, sentry,
];
```

## 3. Per-action permissions (the Arcade-style matrix)

### Actions are declared, not inferred

Every capability op gets a declaration in the service (or capability factory):

```ts
type Access = "read" | "write" | "destructive";

interface ActionSpec {
  id: string;        // "<capability>.<op>", e.g. "mail.send", "files.delete"
  access: Access;
  label: string;     // Settings row: "Send email", "Delete remote file"
}
```

The shared capability factories (`makeMailOps`, `makeWebdavOps`, …) export
their action lists once, so a service that uses `makeMailOps` gets
`mail.folders/search/read/send` declared for free; services with bespoke ops
declare their own. **Smoke asserts every dispatchable op has a declared
action** — same philosophy as the type-required `test`.

Access classes and defaults:

| class | meaning | default |
|---|---|---|
| `read` | reads remote state; includes **downloads** (remote → chat file area) | **allow** |
| `write` | creates/sends/modifies remote state; includes **uploads** (file area → remote) — this is data *egress* | **ask** |
| `destructive` | deletes remote data (`files.delete`, future `mail.trash`) | **ask** (and hard-deny unattended, §5) |

Direction matters more than location: pulling an attachment *into* the sandbox
is `read`; pushing a sandbox file *out* to Telegram is `write`.

### Storage & resolution

Per-account overrides live on the account row (non-secret, `accounts.json`):

```ts
interface ConnectorAccount {
  …
  disabled?: boolean;                                  // kill switch (§5)
  permissions?: Record<string /*actionId*/, "allow" | "ask" | "deny">;
}
```

Resolution order (first hit wins):
1. account override → 2. service-declared default → 3. class default.

### Settings UI (generic, data-driven)

One component renders every service's matrix from `UiConnectorService.actions`:
grouped **Read / Write / Destructive**, three-state toggle per row
(✓ allow · ✋ ask · 🚫 deny), a preset dropdown per group
(*Allow all / Ask all / Deny all / Custom* — "Custom" is derived, not stored).
Mirrors the reference screenshot without any per-service UI code.

### Enforcement point

`agent/connector-tools.ts`, in the shared tool handler, **before** dispatching
to `acct.service.capabilities.*` — one gate for all services:

```
level = resolve(acct, actionId)
deny  → ProtocolResult error "blocked by <Service> permissions (Settings → Connectors)"
ask   → interactive: requestPermission(…) — the EXISTING renderer dialog +
        per-session "Allow always" grants (vendor-tools.ts already has both);
        bypassPermissions/auto modes skip the ask (consistent with shell/file tools);
        unattended: DENY with a clear error (§5)
allow → proceed
```

The permission card shows the service icon, action label, and a human summary
built from the input ("Send email to X — subject 'Y'", "Upload report.pdf to
Disk:/docs"). Ops themselves stay permission-unaware.

## 4. File exchange — `lib/file-bridge.ts`

The generalization of what Telegram `resolveUpload` already proved: connectors
must read/write **the chat's file area** and nothing else.

```ts
interface FileBridge {
  space: "home" | "code";
  root: string;                 // Home: sandboxWorkDir(sessionId) · Code: getCwd() (per-run ALS)
  resolveRead(path: string): string;      // confined; throws with a helpful message outside root
  write(name: string, data: Buffer | Readable, opts?: { mime?: string }):
    Promise<{ path: string; artifactLine: string }>;  // "[artifact] <mime> <name> :: <abs>"
}
const makeFileBridge: (sessionId: string, space?: string) => FileBridge;
```

Rules:
- **Home**: root is the chat's sandbox — the same isolation promise as the
  sandbox engines; connectors are a *bridge*, not an escape hatch.
- **Code**: root is the run's own cwd (`getCwd()` — the AsyncLocalStorage
  per-run pin), so parallel chats download into their own folders.
- Traversal-safe (`resolve` + prefix check incl. the `sep` edge), size cap
  (default 50 MB, per-call override), collision-safe names (`name (2).ext`).
- Every write returns the `[artifact]` marker line already parsed by
  `ToolCallBubble`/`SandboxOutput` — downloads appear as file chips /
  thumbnails in the chat and in the Files panel with **zero renderer work**.

### Context threading

Ops get a third parameter instead of today's ad-hoc `space?/sessionId?` fields
(the `ChatOps.sendFile` hack is removed):

```ts
interface ConnectorContext {
  files: FileBridge;
  sessionId: string;
  space?: string;
  signal?: AbortSignal;
}
// every op: (acct, opts, ctx) => Promise<ProtocolResult>
```

### New file-moving ops (all declared as actions)

| tool | action | class | what |
|---|---|---|---|
| Mail | `mail.download_attachment` | read | message part → `ctx.files.write` |
| Mail | `mail.send` gains `attachments: string[]` | write | bridge-resolved paths |
| CloudFiles | `files.download` | read | Drive/Disk file → file area |
| CloudFiles | `files.upload` | write | file area → Drive/Disk (streams, not the string-only `write`) |
| Telegram | `chat.send_file` | write | (exists — moves onto the bridge) |
| Telegram | `chat.download_media` | read | message media → file area |

GitHub file ops (release assets, repo files) follow the same pattern later.

## 5. Network & scoping model

Connectors run in the **main process** — they *are* the network. The sandbox
engines stay no-network; connectors are the only bridge, and every call goes
through the §3 gate. Three layers, coarse → fine:

1. **Kill switch** — `account.disabled`: connector stays configured but is
   invisible to the agent (not advertised, not executable).
2. **Per-chat scoping** — which connectors this chat/routine may use at all
   (routines have it; the composer picker for regular chats is Phase 4).
3. **Per-action permission** — §3.

For comparison, cloud routines (code.claude.com/docs/en/routines) include all
connectors by default and allow **every** tool "including writes, without
asking" — acceptable there because the *environment* is sandboxed and
network-allowlisted (Trusted/Custom/Full). Our runs touch the user's real
accounts from their real machine, so we invert the default: **unattended runs
deny every `ask`-class action** unless the routine explicitly granted it:

```ts
interface Routine { …, grants?: string[] /* actionIds allowed while unattended */ }
```

CreateRoutine asks the human *once, at creation time* ("this routine will send
Telegram messages — allow `chat.send`?") and stores the grant. `destructive`
is never grantable to unattended runs. This is the routines-doc "Permissions
tab" idea, applied at action granularity.

Per-domain allowlists (the cloud's other knob) are meaningless here: every
service already declares its fixed endpoints, and README's verification rules
forbid inventing new ones.

## 6. Telegram Bot (`services/telegram/bot/`, id `telegram-bot`)

A second Telegram service over the **HTTPS Bot API** (`api.telegram.org/bot<token>/…`)
— no MTProto session fragility, ideal as the routines notification channel.

- auth: `token` (from @BotFather), `credUrl: https://t.me/BotFather`.
- capabilities.chat: `send`, `sendFile`, `updates` (messages sent *to* the
  bot via getUpdates), `test` = `getMe`.
- Honest limits in `setupSteps`/`note` (bots cannot DM a user until that user
  presses **Start**; bots don't read arbitrary chat history — that's what the
  MTProto `account/` service is for; channel posting needs admin rights).
- `promptHint` distinguishes it from the account service so the model picks
  the right one ("messages appear as the bot, not as the user").

## 7. MCP and connectors — one model

The user's read is correct: claude.ai "connectors" *are* MCP servers with auth
and branding. Here, **connector** is the broader unit — a service that exposes
capabilities to the agent, where the transport is a detail:

- protocol-backed (IMAP/DAV/WebDAV/REST): our Mail/CloudFiles/Calendar/… tools;
- MCP-backed (`capabilities.mcp`): Notion/Linear/Sentry — local stdio servers
  with the token injected into env; their tools surface individually.

Planned: **Custom MCP** (Phase 4) — a user-defined service (command, args, env)
registered from Settings; it becomes a connector like any other. Its actions
are dynamic (the server's tool list): default **ask** for every tool, honoring
MCP `readOnlyHint` annotations as `read`/allow. Remote OAuth-2.1 MCP servers
remain out until app-side OAuth lands (see memory: pasted tokens get 401).

## 8. Phases

Each phase lands green (`typecheck` + `build` + `smoke:agent`) and committed
separately; the registry/README update travels with Phase 1.

1. **Restructure** *(pure moves, zero behavior change)* — company folders,
   `lib/protocols/`, company sub-registries, `oauth/` → `google/auth.ts`,
   README rewrite. Smoke proves the service list is byte-identical.
2. **Permissions** — `ActionSpec` on every op (factories export theirs), the
   engine in `lib/permissions.ts`, the gate in `connector-tools.ts`, account
   overrides in `store.ts`, the generic Settings matrix. Smoke: every op has
   an action; engine unit tests (override beats default, deny beats ask,
   unattended denies ask, bypass skips ask but never overrides deny).
3. **FileBridge** — `lib/file-bridge.ts` (+ traversal/size tests), ctx
   threading, the §4 ops, `sendFile` hack removed, artifact lines end-to-end.
4. **New surface** — `telegram-bot`, routine grants in CreateRoutine + the
   scheduler, per-chat connector picker, Custom MCP, (optional) an audit log
   of allowed/denied write actions per session.

## 9. Non-goals (for now)

- Remote OAuth 2.1 MCP connectors (needs app OAuth flow).
- Per-domain network allowlists (endpoints are service-declared and fixed).
- Sharing/central management of routines (cloud feature; ours are per-user).
- Per-service React UI — permanently a non-goal; data-driven or it doesn't ship.

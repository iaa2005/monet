# Connector services

A **service** is one folder here that carries *everything* about one
integration: identity, icon, auth, the connect form, setup instructions,
capabilities the agent can use, its test, and every user-facing message. The
only outside touch-point is **two lines in `registry.ts`**. Nothing anywhere
else in Monet names an individual service.

This guide is written for both humans and AI agents adding services. Follow it
literally — every rule below was paid for with a real debugging session.

## Anatomy of a service

```
services/
  yandex-disk/
    index.ts      ← the whole definition (ConnectorService object)
    icon.svg      ← inline-able brand icon (see icon rules)
  registry.ts     ← import + array entry (the ONLY shared edit)
  types.ts        ← the contract (ConnectorService, AuthSpec, capabilities)
  google-setup.ts ← shared walkthrough for Google OAuth services
  yandex-setup.ts ← shared Yandex facts (password activation, per-service types)
  mcp-test.ts     ← shared test for MCP-backed services
```

Shared protocol code lives in `../lib/` (`mail.ts` IMAP/SMTP, `files.ts`
WebDAV, `dav.ts` CalDAV/CardDAV, `gdrive.ts`, `gpeople.ts`, `telegram.ts`).
A service **parameterizes** a lib (hosts, URLs, error wording) or brings its own
logic right in its folder if the protocol is new. Services never import each
other.

## Adding a service, step by step

### 1. Create the folder and definition

```ts
// services/fastmail/index.ts
import icon from "./icon.svg?raw";
import { makeMailOps } from "../../lib/mail.js";
import type { ConnectorService } from "../types.js";

const ops = makeMailOps({
  imap: { host: "imap.fastmail.com", port: 993, secure: true },
  smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
  authHint: "check the app password — Fastmail issues them under Settings → Privacy & Security.",
});

export const Fastmail: ConnectorService = {
  id: "fastmail",                    // folder name; NEVER change once shipped
  name: "Fastmail",                  // display: CompanyProduct, e.g. "YandexDisk"
  company: "Fastmail",               // grouping header in the UI
  description: "Read, search and send email.",
  iconSvg: icon,
  auth: {
    kind: "password",
    fields: [
      { key: "username", label: "Login", placeholder: "you@fastmail.com" },
      { key: "password", label: "App password", secret: true },
    ],
  },
  credUrl: "https://app.fastmail.com/settings/security",
  credLabel: "Create app password",
  capabilities: { mail: ops },
  test: (acct) => ops.folders(acct),  // REQUIRED — see "The test is law"
};
```

### 2. Register it (the two lines)

```ts
// registry.ts
import { Fastmail } from "./fastmail/index.js";
// …
export const SERVICES: ConnectorService[] = [ /* …, */ Fastmail ];
```

Done. The card, the connect form, the setup walkthrough, the Test button, the
agent tools, routine scoping and the context meter all pick it up from the
registry. Removing a service = delete the two lines and the folder (user
accounts referencing it become unresolvable and disappear from tools; they are
not deleted from disk).

### 3. Run the checks

```
npm run typecheck && npm run smoke:agent && npm run build
```

`smoke:agent` asserts every service has a test, a credential link, a
capability, correct naming, and inline-SVG icons. It will name your service if
you missed one.

## The contract (types.ts)

### `auth` — the connect form is rendered from data

| kind | Renders | Where values go |
|---|---|---|
| `password` | your `fields` list | `key:"username"` → account login; other keys → encrypted secret |
| `token` | one masked field | secret under the field's key (use `password`) |
| `google-oauth` | client id/secret + "Sign in with Google" | tokens stored by the sign-in flow; `scopes` come from your definition |
| `telegram` | phone + api_id/api_hash → SMS code (+2FA) | handled by the telegram lib |
| `unavailable` | an explanation card, no form | nothing — `reason` says what to do instead |

The renderer has exactly these five branches and **no per-service code**. If
your service needs a sixth auth shape, extend `AuthSpec` and the renderer once,
for everyone.

### `capabilities` — what the agent can do

| capability | Served by shared tool | Ops you implement |
|---|---|---|
| `mail` | **Mail** | folders / search / read / send |
| `files` | **CloudFiles** | list / read / write / delete / mkdir |
| `calendar` | **Calendar** | calendars / events / create |
| `contacts` | **Calendar** (action `contacts`) | list |
| `chat` | **Telegram** | chats / topics / history / send / sendFile |
| `mcp` | its own MCP server | `{ command, args, envKey }` — the stored token is injected into env at spawn; it never touches mcp-servers.json |

One tool per capability keeps the model's schema flat no matter how many
services are connected. The tool dispatches to
`acct.service.capabilities.<cap>` — your implementation, your errors.

`promptHint` (optional) is appended to the owning tool's prompt **only while an
account of your service is connected** — put service-specific model guidance
there ("delete moves to trash", "messages appear as the user"), not in the tool.

### `test` — the test is law

`test` is type-required on every service. It must be the **cheapest real call
that proves the stored credential works** (list one folder, one contact, one
chat). History: a Test branch was once forgotten, the handler defaulted to
`ok: true`, and the UI showed “works” for a connector that had never been
contacted. A whole debugging session was built on that false green — four app
passwords were created to fix a problem that didn't exist. A tick that proves
nothing is worse than no tick.

For `unavailable` services, return the reason as an error. For MCP services use
`makeMcpTest(id)`.

### Storage — you don't touch it

Accounts live in `accounts.json` (service id under the legacy key `presetId`),
secrets in `secrets.json`, encrypted with the OS keychain (DPAPI/Keychain).
Your ops receive a `ResolvedAccount` with the decrypted `secret`. Rules learned
the hard way:

- Secrets are **trimmed on write only**. Never "repair" stored credentials on
  read — a read-side trim once broke a working connector. What's stored is
  what the user gave us.
- Use `patchSecret(accountId, {...})` to persist refreshed tokens/sessions.
- Never send a secret to the renderer. Sign-in flows run in main and store the
  result; IPC returns `{ok, error}` only.

## Verification rules (non-negotiable)

This catalog once shipped **guessed** endpoints: npm packages that didn't
exist, OAuth-only URLs fed pasted tokens, a CardDAV principal invented three
times. Users then debugged *their* credentials against *our* fiction. Hence:

1. **Never write down an endpoint you haven't probed.** `curl -sS -D - <url>`
   with a **bogus** credential: an auth-shaped failure (401 +
   `WWW-Authenticate`, `AUTHENTICATIONFAILED`) proves host/port/scheme are
   right. A 404/405/redirect means your URL is wrong. Never probe with real
   user credentials — and go easy: repeated failures can trip anti-bruteforce
   on the USER's account when run from their machine.
2. **A `WWW-Authenticate: Basic` header is not proof Basic works.** Google's
   DAV endpoints send it and refuse every password (`loginRequired`). The only
   settling experiment is the same credential succeeding on one endpoint and
   failing on another.
3. **npm packages:** `npm view <pkg> version` before referencing one.
4. **Quote the server.** When a lib swallows the response (tsdav collapses
   everything to "cannot find homeUrl"; imapflow hides `responseText`), dig the
   real words out — Google's "API has not been used in project N" message is
   the whole fix. Your `authHint` config is where service-specific translations
   live.
5. **Known provider facts** (verified, keep true):
   - Yandex app passwords activate **2–3 hours after creation** (official docs)
     and are **scoped per service** — a Mail password is refused by Disk.
     Advising "recreate it" restarts the activation clock; never do.
   - Google: app password works for Gmail IMAP/SMTP **only**. Calendar =
     CalDAV+OAuth, Contacts = People API (its CardDAV 404s valid tokens),
     Drive = REST+OAuth. One Desktop OAuth client covers all; consent screens
     in "Testing" expire refresh tokens weekly; `access_type=offline` +
     `prompt=consent` or no refresh token after the first grant.
   - Remote MCP (Notion/Linear/Sentry/GitHub-Copilot) is OAuth 2.1 and rejects
     pasted tokens; local stdio servers with env tokens are the working path.

## Icons

- `icon.svg` in the folder, imported `?raw`, inlined in the UI.
- **Namespace every `id=` inside the SVG** (`gmail-a`, not `a`). Gmail,
  Calendar and Drive all ship `id="a"` — inlined side by side, `url(#a)`
  resolves to whichever icon rendered first and one logo wears another's
  colors.
- Root: `viewBox` + `width="100%" height="100%"`, no fixed px. Keep a root
  `fill` if the brand sets one (Linear inherits its color from the root).
- Dark backgrounds: a bare dark silhouette (GitHub) needs a light disc behind
  it, like the other icons carry.
- No `<script>`, no external refs. Icon optional — the UI falls back to a plug.

## Routines

Routines speak the same registry. A routine's `connectors: string[]` holds
**service ids**; scoping derives from your `capabilities` (a routine scoped to
`["fastmail"]` gets the Mail tool and nothing else; an MCP service scopes its
server by name). The routine UI's picker, event-trigger source list and output
list all come from `connectors:options` — your service appears there the moment
an account is connected, under its display `name`. Nothing to wire.

## Naming

`name` is CompanyProduct with no space — `GoogleGmail`, `YandexDisk`,
`Telegram` when the product IS the company. `id` is kebab-case and eternal:
user accounts on disk reference it, so renaming an id orphans accounts.
`company` is the UI grouping header.

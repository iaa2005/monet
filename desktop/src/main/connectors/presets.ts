/**
 * Connector presets — the whole "catalog" is this table.
 *
 * Adding a service = one entry. No new code, as long as it speaks a protocol
 * we already have an adapter for. Mail.ru, Fastmail, iCloud, Nextcloud etc.
 * are all just rows waiting to be typed.
 *
 * Every endpoint below was probed live before being written down (see the
 * header of types.ts) — this file must never contain a guessed host.
 */

import type { ConnectorPreset } from "./types.js";

export const PRESETS: ConnectorPreset[] = [
  // ─── Google ──────────────────────────────────────────────────────────────
  // No cloud project, no OAuth client, no subscription: an app password over
  // IMAP/SMTP. Requires 2-Step Verification — Google only issues app passwords
  // to accounts that have it on, and Workspace admins can disable them.
  {
    id: "gmail",
    name: "Gmail",
    group: "Google",
    protocols: ["imap", "smtp"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    credUrl: "https://myaccount.google.com/apppasswords",
    credLabel: "App password (16 characters)",
    usernameLabel: "you@gmail.com",
    note: "Needs 2-Step Verification turned on — Google only offers app passwords then. Gmail's IMAP speaks X-GM-EXT-1, so search uses real Gmail query syntax (e.g. from:bob has:attachment).",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    group: "Google",
    // App passwords do NOT work here, whatever the WWW-Authenticate header
    // says. Proven the only way that settles it: the same app password that
    // Gmail accepts over IMAP is refused by CalDAV, which answers the GData
    // error `loginRequired`. The `basic realm="Google APIs"` challenge these
    // endpoints send is a leftover and means nothing — hence OAuth.
    //
    // Still CalDAV underneath: Google documents OAuth over CalDAV, so the same
    // adapter serves this and Yandex, only the auth differs. The principal is
    // spelled out because Google serves no current-user-principal at the root.
    protocols: ["caldav"],
    caldav: {
      url: "https://apidata.googleusercontent.com/caldav/v2/",
      principalTemplate:
        "https://apidata.googleusercontent.com/caldav/v2/{username}/user",
    },
    oauth: {
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    },
    credUrl: "https://console.cloud.google.com/apis/credentials",
    credLabel: "OAuth client (Desktop app)",
    usernameLabel: "you@gmail.com",
    note: "Google refuses an app password here, so this signs in instead. One-time setup in Google Cloud: (1) create an OAuth client of type “Desktop app”; (2) enable the Calendar API; (3) on the consent screen add YOUR OWN address under Test users — miss this and sign-in dies with “access_denied, app not verified”; (4) paste the client id/secret here. While the consent screen stays in “Testing”, Google expires the sign-in about weekly — set it to “In production” to stop that. The “unverified app” warning is expected: it's your own client, so click through it.",
  },
  {
    id: "google-contacts",
    name: "Google Contacts",
    group: "Google",
    // Same story as the calendar: CardDAV answers a supplied app password with
    // `UNAUTHENTICATED`, so it signs in too. Shares the calendar's client — one
    // OAuth client covers every Google scope.
    protocols: ["carddav"],
    carddav: {
      url: "https://www.googleapis.com/carddav/v1/principals/",
      principalTemplate:
        "https://www.googleapis.com/carddav/v1/principals/{username}",
    },
    oauth: {
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/carddav"],
    },
    credUrl: "https://console.cloud.google.com/apis/credentials",
    credLabel: "OAuth client (Desktop app)",
    usernameLabel: "you@gmail.com",
    note: "Same OAuth client as Google Calendar — reuse the id/secret. Enable the CardDAV API in Google Cloud for this one.",
  },
  // Drive is the one Google service with NO app-password path: Gmail has IMAP,
  // Calendar has CalDAV, Contacts has CardDAV — Drive has no legacy protocol at
  // all, only an API behind OAuth. Probed: a Basic-auth call to
  // googleapis.com/drive/v3/files returns 403 "Method doesn't allow
  // unregistered callers … use API Key or other form of API consumer identity",
  // PROPFIND on drive.google.com is 405, and there is no DAV endpoint.
  //
  // Rather than an OAuth client, we point at Drive for Desktop: it mounts Drive
  // as a real drive letter, which the file tools already handle — the best
  // connector here is no connector.
  {
    id: "google-drive",
    name: "Google Drive",
    group: "Google",
    protocols: [],
    unavailable:
      "Drive needs no connector — install Google Drive for Desktop and it mounts as an ordinary drive (usually G:). Open that folder as a workspace in Code and the agent reads and writes it with the normal file tools, with no password to paste and nothing to keep in sync. (Drive is the one Google service with no app-password path: it has no IMAP/CalDAV-style protocol, only an API behind OAuth, and it refuses a password outright.)",
    unavailableLabel: "Use Drive for Desktop — read how",
    credLabel: "Download Drive for Desktop",
    credUrl: "https://www.google.com/drive/download/",
  },

  // ─── Yandex ──────────────────────────────────────────────────────────────
  // One app password covers all of these; scope is picked when creating it.
  {
    id: "yandex-mail",
    name: "Yandex Mail",
    group: "Yandex",
    protocols: ["imap", "smtp"],
    imap: { host: "imap.yandex.ru", port: 993, secure: true },
    smtp: { host: "smtp.yandex.ru", port: 465, secure: true },
    credUrl: "https://id.yandex.ru/security/app-passwords",
    credLabel: "App password — pick the “Mail” type",
    usernameLabel: "you@yandex.ru",
    note: "Turn on IMAP in Yandex Mail settings first (Settings → Mail clients).",
  },
  {
    id: "yandex-disk",
    name: "Yandex Disk",
    group: "Yandex",
    protocols: ["webdav"],
    webdav: { url: "https://webdav.yandex.ru" },
    credUrl: "https://id.yandex.ru/security/app-passwords",
    credLabel: "App password — pick the “Files (WebDAV)” type",
    usernameLabel: "you@yandex.ru",
  },
  {
    id: "yandex-calendar",
    name: "Yandex Calendar",
    group: "Yandex",
    protocols: ["caldav"],
    caldav: { url: "https://caldav.yandex.ru" },
    credUrl: "https://id.yandex.ru/security/app-passwords",
    credLabel: "App password — pick the “Calendar (CalDAV)” type",
    usernameLabel: "you@yandex.ru",
    // Unlike Google, Yandex documents app passwords for CalDAV — but its 401
    // challenge looks identical to Google's, and that challenge is exactly what
    // fooled us there. Hit Test after connecting; only that settles it.
    note: "Yandex documents app passwords for CalDAV, but this hasn't been confirmed end-to-end — press Test after connecting.",
  },
  {
    id: "yandex-contacts",
    name: "Yandex Contacts",
    group: "Yandex",
    protocols: ["carddav"],
    carddav: { url: "https://carddav.yandex.ru" },
    credUrl: "https://id.yandex.ru/security/app-passwords",
    credLabel: "App password — pick the “Contacts (CardDAV)” type",
    usernameLabel: "you@yandex.ru",
  },

  // ─── Developer tools (MCP over stdio) ────────────────────────────────────
  // These ship real MCP servers, so the "protocol" is MCP itself: we spawn the
  // vendor's server locally and hand it the token via env. Their REMOTE servers
  // are deliberately not used — Notion's is OAuth-only (401 to a pasted token)
  // and GitHub's is Copilot-gated (402).
  {
    id: "github",
    name: "GitHub",
    group: "Developer tools",
    protocols: ["mcp"],
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    },
    credUrl: "https://github.com/settings/tokens",
    credLabel: "Personal access token",
    note: "Classic tokens work; give it repo scope. GitHub's remote MCP server needs a Copilot subscription, so this runs the local one with your token.",
  },
  {
    id: "notion",
    name: "Notion",
    group: "Developer tools",
    protocols: ["mcp"],
    mcp: {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      envKey: "NOTION_TOKEN",
    },
    credUrl: "https://app.notion.com/developers/tokens",
    credLabel: "Internal integration token (ntn_…)",
    note: "After connecting, open each page or database in Notion → ••• → Connections → add your integration. Without that it authenticates fine but sees nothing.",
  },
  {
    id: "slack",
    name: "Slack",
    group: "Developer tools",
    protocols: ["mcp"],
    mcp: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      envKey: "SLACK_BOT_TOKEN",
    },
    credUrl: "https://api.slack.com/apps",
    credLabel: "Bot token (xoxb-…)",
    note: "Create an app → OAuth & Permissions → add bot scopes → install to workspace, then copy the Bot User OAuth Token.",
  },
  // Linear and Sentry run OAuth-only remote MCP servers: probed, both answer a
  // pasted token with 401 invalid_token + WWW-Authenticate: Bearer realm="OAuth".
  // Until the app does the OAuth sign-in flow there is nothing to paste here.
  {
    id: "linear",
    name: "Linear",
    group: "Developer tools",
    protocols: [],
    unavailable:
      "Linear's MCP server signs you in with your account (OAuth) rather than a token — it answers a pasted token with 401. This app doesn't do the OAuth sign-in flow yet, so Linear can't be connected from here.",
    unavailableLabel: "Needs OAuth — read why",
    credLabel: "Linear MCP docs",
    credUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    group: "Developer tools",
    protocols: [],
    unavailable:
      "Sentry's MCP server signs you in with your account (OAuth) rather than a token — it answers a pasted token with 401. This app doesn't do the OAuth sign-in flow yet, so Sentry can't be connected from here.",
    unavailableLabel: "Needs OAuth — read why",
    credLabel: "Sentry MCP docs",
    credUrl: "https://docs.sentry.io/product/sentry-mcp/",
  },

  // ─── Telegram ────────────────────────────────────────────────────────────
  // MTProto against YOUR account (GramJS), so it can read your real chats — a
  // bot only ever sees chats it was added to. api_id/api_hash come from
  // my.telegram.org (a short form, not a cloud console); the phone code is
  // entered once and we keep the resulting session string.
  {
    id: "telegram",
    name: "Telegram",
    group: "Telegram",
    protocols: ["telegram"],
    telegram: true,
    credUrl: "https://my.telegram.org/apps",
    credLabel: "api_id + api_hash",
    usernameLabel: "+79991234567",
    note: "Sign in as yourself: create an app at my.telegram.org to get api_id/api_hash, then confirm the code Telegram sends you. Reads your own chats — a bot cannot.",
  },
];

export function getPreset(id: string): ConnectorPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

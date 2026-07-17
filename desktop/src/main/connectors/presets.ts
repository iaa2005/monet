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

import type { ConnectorPreset, SetupStep } from "./types.js";

/**
 * The Google Cloud walkthrough, shared by every Google connector — one OAuth
 * client covers them all, so only the API to enable differs.
 *
 * Written out step by step because each omission fails in a way that blames the
 * wrong thing: no API → 403 on first use; no test user → "access_denied, app not
 * verified", which reads as if the app is broken; still in Testing → works, then
 * silently dies in a week.
 */
function googleSetup(api: { name: string; url: string }): SetupStep[] {
  return [
    {
      text: "Open Google Cloud Console and create a project (or pick one you already have).",
      url: "https://console.cloud.google.com/projectcreate",
      urlLabel: "New project",
    },
    {
      text: `Enable the ${api.name} for that project — without it every call comes back 403, even after a perfect sign-in.`,
      url: api.url,
      urlLabel: `Enable ${api.name}`,
    },
    {
      text: "Credentials → Create credentials → OAuth client ID. Application type: Desktop app. Name it anything. Create — then keep the client ID and secret (the JSON download has both).",
      url: "https://console.cloud.google.com/apis/credentials",
      urlLabel: "Credentials",
    },
    {
      text: "Audience → Test users → Add users → your own Gmail address. Miss this and sign-in dies with “access_denied — app not verified”, as if the app were broken. It isn't: you're just not on your own guest list.",
      url: "https://console.cloud.google.com/auth/audience",
      urlLabel: "Audience",
    },
    {
      text: "Same page: Publish app. Optional, but while it stays in “Testing” Google expires the sign-in about every 7 days and the connector quietly stops. Verification isn't needed — that's for handing the app to other people.",
      url: "https://console.cloud.google.com/auth/audience",
      urlLabel: "Audience",
    },
    {
      text: "Paste the client ID and secret below, then Sign in with Google. The browser will warn “Google hasn't verified this app” — expected, it's your own client: Advanced → Go to … → Allow.",
    },
  ];
}

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
    note: "Google takes an app password for Gmail but refuses one here, so Calendar signs in instead. Set up once — the same client then works for every Google connector.",
    setupSteps: googleSetup({
      name: "Google Calendar API",
      url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    }),
  },
  {
    id: "google-contacts",
    name: "Google Contacts",
    group: "Google",
    // NOT CardDAV. Google's CardDAV answers a valid OAuth token with a 404 HTML
    // page, and its principal paths aren't documented anywhere reachable — three
    // guesses, three misses. People API is what Google documents for contacts.
    protocols: ["gpeople"],
    oauth: {
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    },
    credUrl: "https://console.cloud.google.com/apis/credentials",
    credLabel: "OAuth client (Desktop app)",
    usernameLabel: "you@gmail.com",
    note: "Reuse the SAME client ID/secret as Google Calendar — one client covers every Google connector. If you already set that up, only step 2 is new. Read-only.",
    setupSteps: googleSetup({
      name: "People API",
      url: "https://console.cloud.google.com/apis/library/people.googleapis.com",
    }),
  },
  // Drive has no standard protocol at all — no DAV, only its REST API behind
  // OAuth (a Basic call to /drive/v3/files answers 403 "unregistered callers";
  // PROPFIND on drive.google.com is 405). So it rides the same OAuth client as
  // Calendar and gets its own adapter behind the shared CloudFiles tool.
  {
    id: "google-drive",
    name: "Google Drive",
    group: "Google",
    protocols: ["gdrive"],
    oauth: {
      provider: "google",
      // Full Drive: anything narrower (drive.file) only sees files this app
      // itself created, which is useless for reading the user's own Drive.
      scopes: ["https://www.googleapis.com/auth/drive"],
    },
    credUrl: "https://console.cloud.google.com/apis/credentials",
    credLabel: "OAuth client (Desktop app)",
    usernameLabel: "you@gmail.com",
    note: "Reuse the SAME client ID/secret as Google Calendar — one client covers every Google connector; only step 2 differs. Drive's scope is a “restricted” one, so expect the unverified-app warning to be firmer. Prefer no setup at all? Google Drive for Desktop mounts Drive as an ordinary drive (usually G:) that the file tools already read — no connector needed.",
    setupSteps: googleSetup({
      name: "Google Drive API",
      url: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
    }),
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
    // The two things that actually go wrong, in the order they go wrong.
    note: "Two steps, and both bite: (1) turn IMAP ON in Yandex Mail → Settings → Mail clients — until you do, Yandex refuses every password with “invalid credentials or IMAP is disabled”, which reads like a bad password; (2) the app password must be the MAIL type. Yandex scopes app passwords per service, so one password will not cover Mail, Disk and Calendar — create one each.",
    setupSteps: [
      {
        text: "Yandex Mail → Settings → Mail clients → tick “From the imap.yandex.ru server via IMAP”, and save. Skipping this makes every password look wrong.",
        url: "https://mail.yandex.ru/#setup/client",
        urlLabel: "Mail clients",
      },
      {
        text: "Create an app password of type “Mail”. A password made for Disk or Calendar will NOT work here — Yandex scopes them per service.",
        url: "https://id.yandex.ru/security/app-passwords",
        urlLabel: "App passwords",
      },
      { text: "Paste your full address and that password below." },
    ],
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
    note: "The app password must be the FILES (WebDAV) type — Yandex scopes them per service, so a Mail password gives 401 here no matter how correct it looks.",
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
    note: "The app password must be the CALENDAR (CalDAV) type — Yandex scopes them per service, so a Mail password gives 401 here. Not yet confirmed end-to-end: press Test after connecting.",
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

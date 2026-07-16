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
    protocols: ["caldav"],
    caldav: { url: "https://apidata.googleusercontent.com/caldav/v2/" },
    credUrl: "https://myaccount.google.com/apppasswords",
    credLabel: "App password (16 characters)",
    usernameLabel: "you@gmail.com",
    note: "Same app password as Gmail — CalDAV accepts it, so no OAuth client needed.",
  },
  {
    id: "google-contacts",
    name: "Google Contacts",
    group: "Google",
    protocols: ["carddav"],
    carddav: { url: "https://www.googleapis.com/carddav/v1/principals/" },
    credUrl: "https://myaccount.google.com/apppasswords",
    credLabel: "App password (16 characters)",
    usernameLabel: "you@gmail.com",
  },
  // Drive is the one Google service with NO app-password path: Gmail has IMAP,
  // Calendar has CalDAV, Contacts has CardDAV — Drive has no legacy protocol at
  // all, only an API behind OAuth. Probed: a Basic-auth call to
  // googleapis.com/drive/v3/files returns 403 "Method doesn't allow
  // unregistered callers … use API Key or other form of API consumer identity",
  // PROPFIND on drive.google.com is 405, and there is no DAV endpoint. So it
  // gets an honest card rather than a form that cannot work.
  {
    id: "google-drive",
    name: "Google Drive",
    group: "Google",
    protocols: [],
    unavailable:
      "Drive has no app-password path — unlike Gmail (IMAP) or Calendar (CalDAV) it has no standard protocol, only an API behind OAuth, and it rejects a password outright. Two ways in: install Google Drive for Desktop and it becomes an ordinary folder the agent can already read and write; or wire OAuth with a one-time Google Cloud client.",
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

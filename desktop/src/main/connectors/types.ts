/**
 * Connectors — core types.
 *
 * The unit of code is a PROTOCOL, not a service: Gmail and Yandex Mail are the
 * same IMAP adapter with different hosts. So adding a service is a row in
 * presets.ts (no new code), and adding a protocol is one file in protocols/.
 *
 * Everything here authenticates with an app password over a standard protocol —
 * deliberately NOT OAuth. Verified against the live endpoints:
 *   imap.gmail.com / imap.yandex.ru  → AUTH=PLAIN
 *   webdav.yandex.ru                 → WWW-Authenticate: Basic realm="Yandex.Disk"
 *   caldav.yandex.ru                 → Basic realm="CalDAV"
 *   Google CardDAV                   → basic realm="Google APIs"
 * That's what lets the user sign in with a password they paste once, instead of
 * registering an OAuth client in a cloud console.
 */

export type ProtocolId =
  | "imap"
  | "smtp"
  | "webdav"
  | "caldav"
  | "carddav"
  | "telegram";

export interface HostPort {
  host: string;
  port: number;
  secure: boolean;
}

/** A connectable service. Declarative: this is the whole definition. */
export interface ConnectorPreset {
  id: string;
  name: string;
  /** Vendor grouping for the UI ("Google", "Yandex", …). */
  group: string;
  protocols: ProtocolId[];
  /** Where to create the app password / credential — opened in a real browser. */
  credUrl?: string;
  /** What to paste, in the user's words. */
  credLabel?: string;
  /** Caveat shown on the form (2FA requirement, sharing rules, …). */
  note?: string;
  /** Login hint, e.g. "you@gmail.com". */
  usernameLabel?: string;
  /**
   * Set when the service CANNOT be connected with an app password, explaining
   * what to do instead. The card still shows (the service is real and people
   * look for it), but offers this instead of a form that would only ever
   * return 401/403.
   */
  unavailable?: string;
  /** Card subtitle for an `unavailable` preset (keep it short and actionable). */
  unavailableLabel?: string;
  imap?: HostPort;
  smtp?: HostPort;
  webdav?: { url: string };
  caldav?: { url: string };
  carddav?: { url: string };
  /** Telegram needs api_id/api_hash + a phone login rather than a password. */
  telegram?: boolean;
}

/** An account the user connected. Secrets live encrypted, never here. */
export interface ConnectorAccount {
  id: string;
  presetId: string;
  /** Display name, defaults to the preset name. */
  label: string;
  /** Login / email / phone. */
  username: string;
  enabled: boolean;
  createdAt: string;
}

/** Decrypted secret material for an account (shape depends on the protocol). */
export interface ConnectorSecret {
  /** App password — IMAP/SMTP/WebDAV/CalDAV/CardDAV. */
  password?: string;
  /** Telegram MTProto. */
  apiId?: string;
  apiHash?: string;
  /** GramJS StringSession, written back after a successful phone login. */
  session?: string;
}

export interface ResolvedAccount {
  account: ConnectorAccount;
  preset: ConnectorPreset;
  secret: ConnectorSecret;
}

/** Uniform result shape every protocol adapter returns to the tool layer. */
export interface ProtocolResult {
  ok: boolean;
  /** Human/model-readable text. */
  text: string;
  error?: string;
}

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
  /** Google Drive's REST API — it has no DAV of any kind, so it can't share the
   * webdav adapter, but it serves the same CloudFiles tool. */
  | "gdrive"
  /** Google Contacts via the People API — its CardDAV 404s a valid token and
   * its paths aren't documented, so contacts go through the documented API. */
  | "gpeople"
  | "caldav"
  | "carddav"
  | "telegram"
  | "mcp";

export interface HostPort {
  host: string;
  port: number;
  secure: boolean;
}

/** One numbered step in a connector's setup. Data, not prose: the OAuth dance
 * is six console steps and any of them missed fails in its own way. */
export interface SetupStep {
  text: string;
  /** Opens in the real browser — usually the exact console page for the step. */
  url?: string;
  urlLabel?: string;
}

export interface DavEndpoint {
  url: string;
  /**
   * Principal URL, with `{username}` substituted — for servers that don't
   * answer discovery. The client normally PROPFINDs the root for
   * `current-user-principal`; Google doesn't serve that at /caldav/v2/, so
   * discovery dead-ends on "cannot find principalUrl". Handing the principal
   * over skips that step, and the calendar home is still discovered from it.
   */
  principalTemplate?: string;
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
  /** Numbered setup walkthrough, shown above the form. */
  setupSteps?: SetupStep[];
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
  caldav?: DavEndpoint;
  carddav?: DavEndpoint;
  /** Telegram needs api_id/api_hash + a phone login rather than a password. */
  telegram?: boolean;
  /**
   * Sign in with Google instead of a password. Needed for Calendar/Contacts:
   * Google takes an app password for mail and refuses one here. The user brings
   * their own Desktop OAuth client, so `scopes` is all we declare.
   */
  oauth?: { provider: "google"; scopes: string[] };
  /**
   * A local MCP stdio server (Notion, GitHub…). MCP-over-stdio is just another
   * protocol here: the token lives encrypted with every other secret and is
   * injected into the server's env at spawn time, so it never reaches
   * mcp-servers.json. `envKey` is the variable that server reads it from.
   */
  mcp?: { command: string; args: string[]; envKey: string };
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
  /** OAuth (Google): the user's own Desktop client, plus what sign-in returned.
   * accessToken/expiry are a cache — the refresh token is what matters. */
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiry?: number;
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

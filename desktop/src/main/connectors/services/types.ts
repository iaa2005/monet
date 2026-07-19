/**
 * The connector service contract.
 *
 * A service is ONE FOLDER under services/ that carries everything about one
 * integration: identity (name, company, icon), how to authenticate (the form is
 * rendered from `auth`, the walkthrough from `setupSteps`), what the agent can
 * do with it (`capabilities` — dispatched by the shared tools), how to prove a
 * credential works (`test`, required), and every user-facing message including
 * its own error hints. Nothing about a service lives anywhere else; the only
 * outside touch-point is one import + one array entry in registry.ts.
 *
 * See services/README.md for the full guide to writing one.
 */

import type {
  ConnectorAccount,
  ConnectorSecret,
  PermissionLevel,
  ProtocolResult,
} from "../types.js";

/** An account resolved for use: stored identity + decrypted secret + the
 * service definition it belongs to. What every capability method receives. */
export interface ResolvedAccount {
  account: ConnectorAccount;
  secret: ConnectorSecret;
  service: ConnectorService;
}

/** Per-call context every capability op receives as its third argument. The
 * FileBridge is THE way an op touches the chat's files (Home: the sandbox;
 * Code: the run's own cwd) — never raw fs paths. */
export interface ConnectorContext {
  files: import("../lib/file-bridge.js").FileBridge;
  sessionId: string;
  space?: string;
}

// ─── Auth: the connect form is RENDERED from this ───────────────────────────

export interface AuthField {
  /** Where the value lands: "username" → the account's login; anything else →
   * that key inside the encrypted secret. */
  key: string;
  label: string;
  placeholder?: string;
  /** Masked in the UI and stored encrypted. */
  secret?: boolean;
  /** Monospace input (tokens, ids). */
  mono?: boolean;
}

export type AuthSpec =
  /** Login + app password (or any set of fields the service declares). */
  | { kind: "password"; fields: AuthField[] }
  /** A single pasted token (MCP servers). Stored as secret.password. */
  | { kind: "token"; field: AuthField }
  /** Sign in with Google: user's own Desktop OAuth client. */
  | { kind: "google-oauth"; scopes: string[] }
  /** Telegram MTProto: api_id/api_hash + phone → SMS code (+2FA). */
  | { kind: "telegram" }
  /** Cannot be connected; the card explains what to do instead. */
  | { kind: "unavailable"; reason: string }
  /** Remote MCP server with OAuth 2.1 (RFC 9728 + DCR). No form fields —
   * sign-in opens the browser; tokens are stored encrypted. */
  | { kind: "oauth-mcp" };

/** One numbered step of the setup walkthrough, shown above the form. */
export interface SetupStep {
  text: string;
  url?: string;
  urlLabel?: string;
}

// ─── Actions: the permission surface ────────────────────────────────────────
//
// Every dispatchable operation is a declared ACTION with an access class; the
// permission engine (lib/permissions.ts) gates each call on the resolved level:
// account override → service default → class default. Read = allow, write =
// ask, destructive = ask (and never grantable to unattended runs). Downloads
// INTO the chat's file area are reads; uploads OUT of it are writes (egress).

export type ActionAccess = "read" | "write" | "destructive";

export interface ActionSpec {
  /** "<capability>.<op>" — e.g. "mail.send". What overrides are keyed by. */
  id: string;
  access: ActionAccess;
  /** Settings row label: "Send email". */
  label: string;
}

export const CLASS_DEFAULT: Record<ActionAccess, PermissionLevel> = {
  read: "allow",
  write: "ask",
  destructive: "ask",
};

/** Every action each capability family exposes. The tool layer's `action`
 * enums and this table MUST agree — smoke asserts it, same philosophy as the
 * type-required `test`. */
export const CAPABILITY_ACTIONS: Record<
  keyof ServiceCapabilities,
  ActionSpec[]
> = {
  mail: [
    { id: "mail.folders", access: "read", label: "List folders" },
    { id: "mail.search", access: "read", label: "Search messages" },
    { id: "mail.read", access: "read", label: "Read a message" },
    // Download = remote → chat file area = read (inbound, no egress).
    {
      id: "mail.download_attachment",
      access: "read",
      label: "Download an attachment",
    },
    { id: "mail.send", access: "write", label: "Send email (+attachments)" },
  ],
  files: [
    { id: "files.list", access: "read", label: "List files" },
    { id: "files.read", access: "read", label: "Read a file" },
    { id: "files.download", access: "read", label: "Download to the chat" },
    { id: "files.write", access: "write", label: "Write a file" },
    { id: "files.upload", access: "write", label: "Upload from the chat" },
    { id: "files.mkdir", access: "write", label: "Create a folder" },
    { id: "files.delete", access: "destructive", label: "Delete a file" },
  ],
  calendar: [
    { id: "calendar.calendars", access: "read", label: "List calendars" },
    { id: "calendar.events", access: "read", label: "Read events" },
    { id: "calendar.create", access: "write", label: "Create an event" },
  ],
  contacts: [{ id: "contacts.list", access: "read", label: "Look up contacts" }],
  chat: [
    { id: "chat.chats", access: "read", label: "List chats" },
    { id: "chat.topics", access: "read", label: "List forum topics" },
    { id: "chat.history", access: "read", label: "Read chat history" },
    { id: "chat.download_media", access: "read", label: "Download media" },
    { id: "chat.send", access: "write", label: "Send a message" },
    { id: "chat.send_file", access: "write", label: "Send a file" },
  ],
  // MCP tools are dynamic (the server's own list), so they gate coarsely as
  // one action; per-tool overrides can come once servers report annotations.
  mcp: [
    { id: "mcp.use", access: "write", label: "Use the service's MCP tools" },
  ],
};

const ACTION_BY_ID = new Map(
  Object.values(CAPABILITY_ACTIONS).flat().map((a) => [a.id, a]),
);

export function findAction(id: string): ActionSpec | undefined {
  return ACTION_BY_ID.get(id);
}

/** All actions a service exposes (its capabilities' actions, in order). */
export function actionsForService(s: ConnectorService): ActionSpec[] {
  return (Object.keys(s.capabilities) as (keyof ServiceCapabilities)[]).flatMap(
    (cap) => CAPABILITY_ACTIONS[cap] ?? [],
  );
}

/** The declared default level for one action of one service. */
export function actionDefaultLevel(
  s: ConnectorService,
  actionId: string,
): PermissionLevel {
  return (
    s.actionDefaults?.[actionId] ??
    CLASS_DEFAULT[findAction(actionId)?.access ?? "write"]
  );
}

// ─── Capabilities: what the shared agent tools dispatch to ─────────────────
//
// One tool per capability family keeps the model's schema flat no matter how
// many services are connected. A service implements only what it truly has.

export interface MailOps {
  folders(acct: ResolvedAccount): Promise<ProtocolResult>;
  search(
    acct: ResolvedAccount,
    opts: { query?: string; folder?: string; limit?: number },
  ): Promise<ProtocolResult>;
  read(
    acct: ResolvedAccount,
    opts: { uid: number; folder?: string },
  ): Promise<ProtocolResult>;
  send(
    acct: ResolvedAccount,
    opts: {
      to: string;
      subject: string;
      body: string;
      cc?: string;
      /** Chat-file-area paths, resolved through ctx.files. */
      attachments?: string[];
    },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
  /** Save one attachment of a message into the chat's file area. */
  downloadAttachment(
    acct: ResolvedAccount,
    opts: { uid: number; folder?: string; name?: string; index?: number },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
}

export interface FileOps {
  list(acct: ResolvedAccount, opts: { path?: string }): Promise<ProtocolResult>;
  read(acct: ResolvedAccount, opts: { path: string }): Promise<ProtocolResult>;
  write(
    acct: ResolvedAccount,
    opts: { path: string; content: string },
  ): Promise<ProtocolResult>;
  delete(acct: ResolvedAccount, opts: { path: string }): Promise<ProtocolResult>;
  mkdir(acct: ResolvedAccount, opts: { path: string }): Promise<ProtocolResult>;
  /** Remote file → the chat's file area (binary-safe). */
  download(
    acct: ResolvedAccount,
    opts: { path: string; saveAs?: string },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
  /** Chat file-area file → remote path (binary-safe). */
  upload(
    acct: ResolvedAccount,
    opts: { file: string; path: string },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
}

export interface CalendarOps {
  calendars(acct: ResolvedAccount): Promise<ProtocolResult>;
  events(
    acct: ResolvedAccount,
    opts: { calendarUrl?: string; days?: number },
  ): Promise<ProtocolResult>;
  create(
    acct: ResolvedAccount,
    opts: {
      title: string;
      start: string;
      end?: string;
      calendarUrl?: string;
      location?: string;
    },
  ): Promise<ProtocolResult>;
}

export interface ContactOps {
  list(
    acct: ResolvedAccount,
    opts: { query?: string; limit?: number },
  ): Promise<ProtocolResult>;
}

export interface ChatOps {
  chats(
    acct: ResolvedAccount,
    opts: { limit?: number; query?: string },
  ): Promise<ProtocolResult>;
  topics(
    acct: ResolvedAccount,
    opts: { chat: string; limit?: number },
  ): Promise<ProtocolResult>;
  history(
    acct: ResolvedAccount,
    opts: { chat: string; limit?: number; query?: string; topic?: number },
  ): Promise<ProtocolResult>;
  send(
    acct: ResolvedAccount,
    opts: { chat: string; message: string; topic?: number },
  ): Promise<ProtocolResult>;
  sendFile(
    acct: ResolvedAccount,
    opts: {
      chat: string;
      /** A chat-file-area path (resolved through ctx.files) or an https URL. */
      file: string;
      caption?: string;
      topic?: number;
      asDocument?: boolean;
    },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
  /** Save a message's media into the chat's file area. */
  downloadMedia(
    acct: ResolvedAccount,
    opts: { chat: string; id: number },
    ctx: ConnectorContext,
  ): Promise<ProtocolResult>;
}

export interface ServiceCapabilities {
  mail?: MailOps;
  files?: FileOps;
  calendar?: CalendarOps;
  contacts?: ContactOps;
  chat?: ChatOps;
  /** A local MCP stdio server; the token is injected into env at spawn. */
  mcp?:
    | { command: string; args: string[]; envKey: string }
    | { url: string; transport?: "http" | "sse" };
}

// ─── The service itself ─────────────────────────────────────────────────────

export interface ConnectorService {
  /** Stable id — the folder name, and what user accounts reference on disk.
   * NEVER change it once shipped: accounts.json rows point at it. */
  id: string;
  /** Compact identifier-style name ("GoogleGmail") — what the model, routines
   * and the context meter use. */
  name: string;
  /** Human-friendly name for Settings ("Google Gmail"). Falls back to `name`. */
  displayName?: string;
  /** The actual company/brand ("Google", "Yandex", "GitHub"; "" if none).
   * Settings groups services under a company header only when it has TWO OR
   * MORE services — a company of one lands in the shared "Other" bucket. */
  company: string;
  /** One line on the card. */
  description: string;
  /** Inline SVG (imported via ?raw). Optional — the UI falls back to a plug
   * icon. Namespace every id inside (url(#a) collides across inlined logos). */
  iconSvg?: string;
  auth: AuthSpec;
  /** Where to get the credential; opened in the real browser. */
  credUrl?: string;
  credLabel?: string;
  /** Caveat shown on the connect form. */
  note?: string;
  setupSteps?: SetupStep[];
  capabilities: ServiceCapabilities;
  /** Per-action default levels overriding the class defaults (rarely needed —
   * e.g. a service whose "write" is unusually risky can default it to deny). */
  actionDefaults?: Record<string, PermissionLevel>;
  /**
   * REQUIRED: the cheapest real call that proves the stored credential works.
   * This exists because a Test branch was once forgotten and the UI showed
   * "works" for a connector that had never been contacted — a false green a
   * whole debugging session was then built on. Type-required so it cannot be
   * forgotten again. Unavailable services return their reason as an error.
   */
  test: (acct: ResolvedAccount) => Promise<ProtocolResult>;
  /** Extra guidance appended to the owning tool's prompt when an account of
   * this service is connected (e.g. Telegram's "messages appear as the user"). */
  promptHint?: string;
}

// ─── UI projection (sent to the renderer over IPC) ──────────────────────────
//
// Functions stripped; the renderer renders the form purely from this data.

export interface UiConnectorService {
  id: string;
  /** Compact identifier-style name ("GoogleGmail") — what the model, routines
   * and the context meter use. */
  name: string;
  /** Human form for Settings ("Google Gmail") — derived: company + space +
   * product when the name starts with the company, else the name as-is. */
  displayName: string;
  company: string;
  description: string;
  iconSvg?: string;
  auth:
    | { kind: "password"; fields: AuthField[] }
    | { kind: "token"; field: AuthField }
    | { kind: "google-oauth" }
    | { kind: "telegram" }
    | { kind: "unavailable"; reason: string }
    | { kind: "oauth-mcp" };
  credUrl?: string;
  credLabel?: string;
  note?: string;
  setupSteps?: SetupStep[];
  /** Capability names, for display ("mail", "files", …). */
  capabilities: string[];
  /** The permission surface: every action with its class and effective default
   * level, for the Settings matrix. */
  actions: (ActionSpec & { defaultLevel: PermissionLevel })[];
}

/** Human name for Settings — explicit `displayName` if set, else `name`. */
export function displayNameOf(s: ConnectorService): string {
  return s.displayName ?? s.name;
}

export function toUiService(s: ConnectorService): UiConnectorService {
  return {
    id: s.id,
    name: s.name,
    displayName: displayNameOf(s),
    company: s.company,
    description: s.description,
    iconSvg: s.iconSvg,
    auth:
      s.auth.kind === "google-oauth" ? { kind: "google-oauth" } : s.auth,
    credUrl: s.credUrl,
    credLabel: s.credLabel,
    note: s.note,
    setupSteps: s.setupSteps,
    capabilities: Object.keys(s.capabilities),
    actions: actionsForService(s).map((a) => ({
      ...a,
      defaultLevel: actionDefaultLevel(s, a.id),
    })),
  };
}

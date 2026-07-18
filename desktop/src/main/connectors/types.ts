/**
 * Connector storage types — the account list and its encrypted secrets.
 *
 * Service definitions (what used to be "presets") live under services/, one
 * folder per service; see services/types.ts for the contract. What remains here
 * is only what the STORE persists, deliberately service-agnostic: an account is
 * a (serviceId, username) pair plus an opaque encrypted secret.
 */

/** What a connector action is allowed to do without/with/never asking. */
export type PermissionLevel = "allow" | "ask" | "deny";

/** An account the user connected. Secrets live encrypted, never here. */
export interface ConnectorAccount {
  id: string;
  /** The service's stable id (folder name under services/). Kept as "presetId"
   * on disk — existing accounts.json files reference it. */
  presetId: string;
  /** Display name, defaults to the service name. */
  label: string;
  /** Login / email / phone. */
  username: string;
  enabled: boolean;
  createdAt: string;
  /** Per-action permission overrides (actionId → level), set in Settings →
   * Connectors → Permissions. Absent = the action's declared default. */
  permissions?: Record<string, PermissionLevel>;
}

/** Decrypted secret material for an account (shape depends on the service). */
export interface ConnectorSecret {
  /** App password or pasted token. */
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

/** Uniform result shape every capability method returns to the tool layer. */
export interface ProtocolResult {
  ok: boolean;
  /** Human/model-readable text. */
  text: string;
  error?: string;
}

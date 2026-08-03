/**
 * Which connectors actually need you to sign in again.
 *
 * A "Sign in" button that is always there teaches the user to click it, and
 * clicking it when nothing is wrong costs a browser round trip and a fresh
 * grant for no reason. So the question is answered rather than delegated:
 * a connector needs the browser when it has no token at all, or when the
 * server it backs has just refused the one it has.
 *
 * The classifier is separate from the lookup because the interesting part is
 * which failures mean "authorise me" — a DNS error or a 500 must NOT send
 * anyone to a login page, and the servers word the auth failure differently
 * (alphaXiv says "Missing Authorization", others say 401 or invalid_token).
 */

import { getSecret, listAccounts } from "./store.js";
import { getService } from "./services/registry.js";
import { displayNameOf } from "./services/types.js";

export type AuthNeedReason = "never-signed-in" | "expired";

export interface McpAuthNeed {
  accountId: string;
  presetId: string;
  label: string;
  reason: AuthNeedReason;
  /** What the server said, when it said anything. */
  detail?: string;
}

/**
 * Does this failure mean the grant is gone, as opposed to the network being
 * down or the server being unwell?
 */
export function isAuthFailure(message: string | undefined): boolean {
  if (!message) return false;
  return /\b401\b|unauthor|missing authorization|invalid[_ ]token|invalid[_ ]grant|token[_ ]expired|forbidden/i.test(
    message,
  );
}

/** True when the account is a remote OAuth MCP one — the only kind that can
 * need a browser after it is installed. */
export function isRemoteMcpService(presetId: string): boolean {
  const mcp = getService(presetId)?.capabilities.mcp;
  return !!mcp && !("command" in mcp);
}

export interface ServerStatusLike {
  status: string;
  error?: string;
}

/**
 * The decision, given what is stored and what the server said. Pure so the
 * rules can be pinned down without a network.
 */
export function authNeedFor(
  hasTokens: boolean,
  status: ServerStatusLike | undefined,
): AuthNeedReason | null {
  if (!hasTokens) return "never-signed-in";
  if (status?.status === "error" && isAuthFailure(status.error)) return "expired";
  return null;
}

/**
 * Every enabled connector waiting on a browser.
 *
 * Reads status rather than probing: `ensureConnected()` has already run by
 * the time anything asks, and a second connect per account would double the
 * launch cost of the one thing the user is being interrupted about.
 */
export async function mcpAuthNeeds(): Promise<McpAuthNeed[]> {
  const { getConnectorServerStatus } = await import("../mcp/manager.js");
  const out: McpAuthNeed[] = [];
  for (const account of listAccounts()) {
    if (!account.enabled) continue;
    if (!isRemoteMcpService(account.presetId)) continue;
    const hasTokens = !!getSecret(account.id).mcpOauthTokens;
    const status = getConnectorServerStatus(account.presetId) ?? undefined;
    const reason = authNeedFor(hasTokens, status);
    if (!reason) continue;
    out.push({
      accountId: account.id,
      presetId: account.presetId,
      label: (() => {
        const s = getService(account.presetId);
        return s ? displayNameOf(s) : account.label;
      })(),
      reason,
      detail: status?.error,
    });
  }
  return out;
}

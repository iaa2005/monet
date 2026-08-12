/**
 * Anthropic-hosted integrations the engine knows how to use, and this app
 * does not have.
 *
 * Four of them, and they are all the same shape: the engine asks whether some
 * Anthropic service is present — a Claude Code IDE extension speaking over
 * MCP, the Claude-in-Chrome MCP server, a remote session running on their
 * cloud, the remote-control bridge — and then does something with the answer.
 * Behind each question sat a real client: OAuth headers, HTTP polling, an
 * organization UUID lookup, a policy-restriction cache.
 *
 * The answer here is always no, and it was always no: none of those services
 * are reachable without an Anthropic account, which this app does not have and
 * does not want. So the clients are deleted and the questions get answered
 * locally.
 *
 * The questions stay rather than being cut out of forty call sites, for the
 * same reason the tracing spans stayed: where the engine asks is information.
 * If Code Monet ever grows its own remote-session story, these are the seams
 * it would fill — with our service, not theirs.
 */

import type {
  MCPServerConnection,
  ConnectedMCPServer,
} from "../mcp/protocol/types.js";
import type { SDKMessage } from "./types/agentSdkTypes.js";

// ── The IDE bridge ────────────────────────────────────────────────────────
// Upstream this recognised a Claude Code extension among the connected MCP
// servers and used it for selection context, diagnostics and a connect
// notification.

export type IdeType =
  | "cursor"
  | "windsurf"
  | "vscode"
  | "jetbrains"
  | "unknown";

export interface IDEExtensionInstallationStatus {
  installed: boolean;
  error: string | null;
  installedVersion: string | null;
}

export function getConnectedIdeClient(
  _mcpClients?: MCPServerConnection[],
): ConnectedMCPServer | undefined {
  return undefined;
}

export function getConnectedIdeName(
  _mcpClients: MCPServerConnection[],
): string | null {
  return null;
}

export async function maybeNotifyIDEConnected(_client: unknown): Promise<void> {}

// ── Claude in Chrome ──────────────────────────────────────────────────────
// Their browser extension exposes itself as an MCP server; the engine
// special-cases it. This app drives a browser through src/main/browser
// instead, so nothing here is ever that server.

export const CLAUDE_IN_CHROME_MCP_SERVER_NAME = "claude-in-chrome";

export function isClaudeInChromeMCPServer(_serverName: string): boolean {
  return false;
}

export const CHROME_TOOL_SEARCH_INSTRUCTIONS = "";

// ── Remote sessions (teleport / Claude Code on the web) ───────────────────
// Hand a branch to their cloud, then poll it for events. Without an account
// there is no session to poll and no environment to list.

export type EnvironmentKind = "anthropic_cloud" | "byoc" | "bridge";

export interface PollRemoteSessionResponse {
  newEvents: SDKMessage[];
  lastEventId: string | null;
  branch?: string;
  sessionStatus?: "idle" | "running" | "requires_action" | "archived";
}

const NO_REMOTE = "This app has no Anthropic remote session backend.";

export async function pollRemoteSessionEvents(
  _sessionId: string,
  _afterId: string | null = null,
  _opts?: { skipMetadata?: boolean },
): Promise<PollRemoteSessionResponse> {
  return { newEvents: [], lastEventId: null };
}

export async function archiveRemoteSession(_sessionId: string): Promise<void> {}

/** Throws rather than returning null: a caller reaching this asked to move
 *  work somewhere, and silently not moving it is the worse failure. The
 *  signature is the original's, so the code that would have handled a session
 *  — including its own null check and its onBundleFail callback — still
 *  typechecks around a call that never returns.
 */
export async function teleportToRemote(_options: {
  initialMessage: string | null;
  description?: string;
  branchName?: string;
  title?: string;
  signal?: AbortSignal;
  onBundleFail?: (message: string) => void;
}): Promise<{ id: string; title: string | null } | null> {
  throw new Error(NO_REMOTE);
}

/** The shape callers read off a remote session. Declared here so the code
 *  that handles one still typechecks; the call always throws. */
export interface RemoteSessionResource {
  type: "session";
  id: string;
  title: string | null;
  session_status: string;
  environment_id: string;
  created_at: string;
  updated_at: string;
}

export async function fetchSession(
  _sessionId: string,
): Promise<RemoteSessionResource> {
  throw new Error(NO_REMOTE);
}

export async function fetchEnvironments(): Promise<[]> {
  return [];
}

export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/** Whether a failed request is worth retrying. Kept real — it is a plain
 *  predicate over an error, and callers use it for their own requests. */
export function isTransientNetworkError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  )
    return true;
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

// ── The remote-control bridge ─────────────────────────────────────────────

export function getBridgeAccessToken(): string | undefined {
  return undefined;
}
export function getBridgeBaseUrlOverride(): string | undefined {
  return undefined;
}
export interface BridgePermissionCallbacks {
  [key: string]: unknown;
}
export function getReplBridgeHandle(): null {
  return null;
}

// ── Account-shaped questions with no account ──────────────────────────────

export type OverageDisabledReason =
  | "overage_not_provisioned"
  | "org_level_disabled"
  | "org_level_disabled_until"
  | "out_of_credits"
  | "seat_tier_level_disabled"
  | "member_level_disabled"
  | "seat_tier_zero_credit_limit"
  | "group_zero_credit_limit"
  | "member_zero_credit_limit"
  | "org_service_level_disabled"
  | "org_service_zero_credit_limit"
  | "no_limits_configured"
  | "unknown";

export interface ClaudeAILimits {
  status: "allowed" | "blocked";
  unifiedRateLimitFallbackAvailable: boolean;
  isUsingOverage: boolean;
  overageDisabledReason?: OverageDisabledReason;
}

/** No account, no server-side limit: nothing is rate-limited here except by
 *  whatever provider the user configured, which reports its own errors. */
export const currentLimits: ClaudeAILimits = {
  status: "allowed",
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
};

export async function getOrganizationUUID(): Promise<string | null> {
  return null;
}

/** Managed-policy restrictions came from the organization. With no
 *  organization, nothing is restricted. */
export function isPolicyAllowed(_policy: string): boolean {
  return true;
}

export function setMockBillingAccessOverride(_value: boolean | null): void {}

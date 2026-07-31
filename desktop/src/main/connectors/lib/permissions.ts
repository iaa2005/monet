/**
 * The connector action permission engine — ONE gate for every connector call.
 *
 * Resolution: account override → service default → class default (read=allow,
 * write=ask, destructive=ask). The resolved level then meets the run context:
 *
 *   deny  → refused outright. Nothing overrides an explicit deny — not
 *           "Skip all approvals", not a routine grant.
 *   allow → proceeds silently.
 *   ask   → interactive runs prompt through the SAME renderer dialog as shell
 *           tools (with per-session "Allow always"); bypassPermissions skips
 *           the ask; auto skips it for read/write but still asks destructive;
 *           unattended runs (routines) DENY unless the action was granted to
 *           the routine at creation — and destructive is never grantable.
 *
 * Why deny-by-default unattended: cloud routines run every connector write
 * without asking, but their blast radius is a sandboxed cloud env. Ours is the
 * user's real accounts from their real machine — the polarity flips.
 */

import type { PermissionLevel } from "../types.js";
import {
  actionDefaultLevel,
  findAction,
  type ResolvedAccount,
} from "../services/types.js";

/** Mirrors the renderer permission dialog contract (vendor-tools.ts). */
export interface PermissionAskFn {
  (ask: { toolName: string; description: string; detail?: string }): Promise<
    "allow" | "allow-once" | "deny"
  >;
}

/** Everything the gate needs to know about the run asking. */
export interface ActionRunContext {
  sessionId?: string;
  permissionMode?: string;
  requestPermission?: PermissionAskFn;
  /** Nobody is watching (a routine firing on schedule). */
  unattended?: boolean;
  /** Action ids the routine's creator granted for unattended use. */
  connectorGrants?: string[];
}

export type ActionGate =
  | { ok: true }
  | { ok: false; message: string };

/** account override → service default → class default. */
export function resolveActionLevel(
  acct: ResolvedAccount,
  actionId: string,
): PermissionLevel {
  // MCP tools gate per tool ("mcp.use.<tool>"), but an override the user set
  // on the blanket "mcp.use" still covers every tool without its own row —
  // the specific always wins when both exist.
  const blanket =
    actionId.startsWith("mcp.use.") && actionId !== "mcp.use"
      ? acct.account.permissions?.["mcp.use"]
      : undefined;
  return (
    acct.account.permissions?.[actionId] ??
    blanket ??
    actionDefaultLevel(acct.service, actionId)
  );
}

// Per-session "Allow always" grants for connector actions, keyed
// sessionId:accountId:actionId — same lifetime as the tool-level grants.
const sessionGrants = new Set<string>();

export function clearConnectorSessionGrants(sessionId: string): void {
  for (const key of sessionGrants)
    if (key.startsWith(`${sessionId}:`)) sessionGrants.delete(key);
}

/**
 * Gate one action. Returns {ok:true} to proceed or {ok:false} with the exact
 * message the model should see (it names the fix: Settings → Connectors).
 */
export async function gateConnectorAction(
  acct: ResolvedAccount,
  actionId: string,
  human: { summary: string; detail?: string },
  ctx: ActionRunContext,
): Promise<ActionGate> {
  const level = resolveActionLevel(acct, actionId);
  const access = findAction(actionId)?.access ?? "write";

  if (level === "deny")
    return {
      ok: false,
      message:
        `${actionId} is blocked for ${acct.service.name} — the user turned it ` +
        `off in Settings → Connectors → Permissions. Do not retry; ask the ` +
        `user to change the setting if they want this.`,
    };
  if (level === "allow") return { ok: true };

  // level === "ask"
  if (ctx.unattended) {
    // A routine's blanket "mcp.use" grant covers each per-tool id too.
    const granted =
      ctx.connectorGrants?.includes(actionId) ||
      (actionId.startsWith("mcp.use.") &&
        ctx.connectorGrants?.includes("mcp.use"));
    if (access !== "destructive" && granted) return { ok: true };
    return {
      ok: false,
      message:
        `${actionId} needs approval and nobody is watching this run. ` +
        (access === "destructive"
          ? `Destructive actions cannot be granted to unattended runs at all.`
          : `Grant it to this routine (edit the routine's permissions), or set ` +
            `it to Allow in Settings → Connectors → Permissions.`),
    };
  }

  if (ctx.permissionMode === "bypassPermissions") return { ok: true };
  if (ctx.permissionMode === "auto" && access !== "destructive")
    return { ok: true };

  const key = `${ctx.sessionId ?? "?"}:${acct.account.id}:${actionId}`;
  if (sessionGrants.has(key)) return { ok: true };

  if (!ctx.requestPermission)
    return {
      ok: false,
      message: `${actionId} needs permission but no prompt channel is available.`,
    };

  const decision = await ctx.requestPermission({
    toolName: acct.service.name,
    description: human.summary,
    detail: human.detail,
  });
  if (decision === "deny")
    return {
      ok: false,
      message: `The user declined: ${human.summary}.`,
    };
  if (decision === "allow") sessionGrants.add(key);
  return { ok: true };
}

/** Read the run context the executor stapled onto a vendor ToolUseContext. */
export function runContextOf(context: unknown): ActionRunContext {
  const c = context as {
    sessionId?: string;
    permissionMode?: string;
    requestPermission?: PermissionAskFn;
    unattended?: boolean;
    connectorGrants?: string[];
  };
  return {
    sessionId: c.sessionId,
    permissionMode: c.permissionMode,
    requestPermission: c.requestPermission,
    unattended: c.unattended,
    connectorGrants: c.connectorGrants,
  };
}

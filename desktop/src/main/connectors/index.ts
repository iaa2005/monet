/**
 * Connectors — the glue between the service registry and the account store,
 * and the public entry point for the tool layer.
 *
 * Tools name an account loosely ("gmail", a label, or nothing at all when only
 * one candidate exists); this resolves that to account + secret + service, and
 * fails with a message listing the real options rather than a bare "not found".
 */

import { getService, SERVICES, servicesWithCapability } from "./services/registry.js";
import { getSecret, listAccounts } from "./store.js";
import type {
  ConnectorService,
  ResolvedAccount,
  ServiceCapabilities,
} from "./services/types.js";
import type { ConnectorAccount } from "./types.js";

export { SERVICES, getService, servicesWithCapability };
export * from "./store.js";
export type * from "./types.js";
export type { ConnectorService, ResolvedAccount } from "./services/types.js";

/** Account + decrypted secret + its service definition. */
export function resolveAccount(id: string): ResolvedAccount | null {
  const account = listAccounts().find((a) => a.id === id);
  if (!account) return null;
  const service = getService(account.presetId);
  if (!service) return null;
  return { account, secret: getSecret(id), service };
}

/** Enabled accounts whose service implements `cap`. */
export function accountsWithCapability(
  cap: keyof ServiceCapabilities,
): ConnectorAccount[] {
  return listAccounts().filter(
    (a) => a.enabled && getService(a.presetId)?.capabilities[cap] != null,
  );
}

/** Connected accounts for `cap`, as a model-facing hint string. */
export function accountHint(cap: keyof ServiceCapabilities): string {
  return accountsWithCapability(cap)
    .map((a) => {
      const label = getService(a.presetId)?.name ?? a.label;
      return a.username ? `${label} (${a.username})` : label;
    })
    .join(", ");
}

/**
 * Resolve the account a tool call means. With exactly one candidate the
 * `account` argument is optional — the common case is a single mailbox, and
 * making the model guess an id it has never seen only invites errors.
 */
export function pickAccount(
  cap: keyof ServiceCapabilities,
  ref?: string,
): ResolvedAccount {
  const rows = accountsWithCapability(cap);
  if (rows.length === 0)
    throw new Error(
      `No ${cap} connector is connected. Add one in Settings → Connectors.`,
    );

  const wanted = ref?.trim().toLowerCase();
  const match = !wanted
    ? rows.length === 1
      ? rows[0]
      : undefined
    : rows.find(
        (a) =>
          a.id === ref ||
          a.label.toLowerCase() === wanted ||
          a.username.toLowerCase() === wanted ||
          a.presetId === wanted ||
          getService(a.presetId)?.name.toLowerCase() === wanted,
      );

  if (!match) {
    const list = rows
      .map((a) => {
        const label = getService(a.presetId)?.name ?? a.label;
        return a.username ? `${label} (${a.username})` : label;
      })
      .join(", ");
    throw new Error(
      wanted
        ? `No ${cap} connector matches “${ref}”. Connected: ${list}.`
        : `Several ${cap} connectors are connected — name one. Connected: ${list}.`,
    );
  }

  const resolved = resolveAccount(match.id);
  if (!resolved)
    throw new Error(`Account ${match.label} is configured but unreadable.`);
  return resolved;
}

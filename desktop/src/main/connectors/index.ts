/**
 * Connectors — public entry point for the tool layer.
 *
 * Tools name an account loosely ("gmail", a label, or nothing at all when only
 * one is connected); this resolves that to a concrete account + preset +
 * decrypted secret, and fails with a message that lists the real options rather
 * than a bare "not found".
 */

import { accountsForProtocol, resolveAccount } from "./store.js";
import type { ProtocolId, ResolvedAccount } from "./types.js";

export { PRESETS, getPreset } from "./presets.js";
export * from "./store.js";
export type * from "./types.js";

/** Accounts speaking `protocol`, as a model-facing hint string. */
export function accountHint(protocol: ProtocolId): string {
  const rows = accountsForProtocol(protocol);
  return rows.map((a) => `${a.label} (${a.username})`).join(", ");
}

/**
 * Resolve the account a tool call means. With exactly one candidate the
 * `account` argument is optional — the common case is a single mailbox, and
 * making the model guess an id it has never seen only invites errors.
 */
export function pickAccount(
  protocol: ProtocolId,
  ref?: string,
): ResolvedAccount {
  const rows = accountsForProtocol(protocol);
  if (rows.length === 0)
    throw new Error(
      `No ${protocol} account is connected. Add one in Settings → Connectors.`,
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
          a.presetId === wanted,
      );

  if (!match) {
    const list = rows.map((a) => `${a.label} (${a.username})`).join(", ");
    throw new Error(
      wanted
        ? `No ${protocol} account matches “${ref}”. Connected: ${list}.`
        : `Several ${protocol} accounts are connected — name one. Connected: ${list}.`,
    );
  }

  const resolved = resolveAccount(match.id);
  if (!resolved)
    throw new Error(`Account ${match.label} is configured but unreadable.`);
  return resolved;
}

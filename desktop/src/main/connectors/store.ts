/**
 * Connector accounts + secrets.
 *
 * Secrets here are app passwords — a Gmail app password is full mailbox access,
 * so they are encrypted at rest with Electron safeStorage (DPAPI/Keychain/
 * libsecret), the same way LLM provider keys already are. They are kept in a
 * SEPARATE file from the account list so the account list can be read, logged
 * and shown freely without ever touching secret material.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { getDataSubdir } from "../data-dir.js";
import { getPreset } from "./presets.js";
import type {
  ConnectorAccount,
  ConnectorSecret,
  ResolvedAccount,
} from "./types.js";

function accountsPath(): string {
  return join(getDataSubdir("connectors"), "accounts.json");
}
function secretsPath(): string {
  return join(getDataSubdir("connectors"), "secrets.json");
}

function encrypt(text: string): string {
  if (!text) return "";
  if (!safeStorage.isEncryptionAvailable()) return text; // fallback: plain
  return safeStorage.encryptString(text).toString("base64");
}

function decrypt(blob: string): string {
  if (!blob) return "";
  if (!safeStorage.isEncryptionAvailable()) return blob;
  try {
    return safeStorage.decryptString(Buffer.from(blob, "base64"));
  } catch {
    return blob; // fallback: written before encryption was available
  }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export function listAccounts(): ConnectorAccount[] {
  try {
    const p = accountsPath();
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, "utf-8")) as ConnectorAccount[];
  } catch {
    return [];
  }
}

function writeAccounts(rows: ConnectorAccount[]): void {
  writeFileSync(accountsPath(), JSON.stringify(rows, null, 2), "utf-8");
}

export function getAccount(id: string): ConnectorAccount | undefined {
  return listAccounts().find((a) => a.id === id);
}

// ─── Secrets ────────────────────────────────────────────────────────────────

type SecretFile = Record<string, string>; // accountId → encrypted JSON

function readSecrets(): SecretFile {
  try {
    const p = secretsPath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as SecretFile;
  } catch {
    return {};
  }
}

function writeSecrets(map: SecretFile): void {
  writeFileSync(secretsPath(), JSON.stringify(map, null, 2), "utf-8");
}

/**
 * Trim every string in a secret.
 *
 * Credentials are pasted, and a paste brings company: app passwords get copied
 * out of a web page with a trailing space or newline riding along. The server
 * then rejects a password the user can see is correct, which is unfalsifiable
 * from their side — they re-copy it and get the same 401.
 *
 * ON WRITE ONLY. Cleaning what arrives is fair; rewriting what's already stored
 * is not — see getSecret.
 */
function trimSecret(secret: ConnectorSecret): ConnectorSecret {
  const out: Record<string, unknown> = { ...secret };
  for (const [k, v] of Object.entries(out))
    if (typeof v === "string") out[k] = v.trim();
  return out as ConnectorSecret;
}

export function getSecret(accountId: string): ConnectorSecret {
  const blob = readSecrets()[accountId];
  if (!blob) return {};
  try {
    // NOT trimmed. Trimming reads rewrites credentials the user never
    // re-entered, and doing that broke a connector that had been working —
    // Yandex Contacts authenticated fine until reads started "repairing" what
    // was stored. Whatever the mechanism, silently rewriting data you cannot
    // see is a guess, not a repair. Cleaning happens on write only.
    return JSON.parse(decrypt(blob)) as ConnectorSecret;
  } catch {
    return {};
  }
}

export function setSecret(accountId: string, secret: ConnectorSecret): void {
  const map = readSecrets();
  map[accountId] = encrypt(JSON.stringify(trimSecret(secret)));
  writeSecrets(map);
}

/**
 * A shape hint for a credential, safe to show: length only, never content.
 *
 * "The password is right and the server still says 401" is unfalsifiable from
 * the user's side — they re-copy the same string and get the same answer. A
 * length they can compare against a connector that DOES work turns that into a
 * fact: same length means look elsewhere, different means a different string
 * got pasted than they think.
 */
export function passwordShape(accountId: string): string {
  const p = getSecret(accountId).password;
  if (!p) return "no password stored";
  return `stored password: ${p.length} chars`;
}

/** Merge into the stored secret — used to persist a Telegram session after login. */
export function patchSecret(
  accountId: string,
  patch: Partial<ConnectorSecret>,
): void {
  setSecret(accountId, { ...getSecret(accountId), ...patch });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Add a connector, or re-connect one.
 *
 * Two mailboxes are a real thing — work and personal Gmail — so a second
 * account under the same preset is allowed when the login differs. What is NOT
 * allowed is a silent twin: an MCP connector is keyed by its preset (one Notion
 * server, one token), so a duplicate would quietly shadow the first, leaving two
 * rows in the UI where only one is live and Test checking the wrong token.
 *
 * So the same preset with the same login — or any second MCP account — REPLACES
 * the existing one. That's also the common case: re-pasting a password that
 * expired.
 */
export function addAccount(input: {
  presetId: string;
  label?: string;
  username: string;
  secret: ConnectorSecret;
}): ConnectorAccount {
  const preset = getPreset(input.presetId);
  if (!preset) throw new Error(`Unknown connector: ${input.presetId}`);

  const username = input.username.trim();
  const existing = listAccounts().find(
    (a) =>
      a.presetId === input.presetId &&
      (!!preset.mcp ||
        a.username.toLowerCase() === username.toLowerCase() ||
        // An account with no login is broken by construction — it can't be
        // addressed — so reconnecting replaces it instead of sitting next to it.
        a.username === ""),
  );
  if (existing) {
    setSecret(existing.id, input.secret);
    const updated = updateAccount(existing.id, {
      username,
      label: input.label?.trim() || existing.label,
      enabled: true,
    });
    return updated ?? existing;
  }

  const account: ConnectorAccount = {
    id: randomUUID(),
    presetId: input.presetId,
    label: input.label?.trim() || preset.name,
    username,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  writeAccounts([...listAccounts(), account]);
  setSecret(account.id, input.secret);
  return account;
}

export function updateAccount(
  id: string,
  patch: Partial<Pick<ConnectorAccount, "label" | "username" | "enabled">>,
): ConnectorAccount | null {
  const rows = listAccounts();
  const i = rows.findIndex((a) => a.id === id);
  if (i < 0) return null;
  rows[i] = { ...rows[i], ...patch };
  writeAccounts(rows);
  return rows[i];
}

export function deleteAccount(id: string): boolean {
  const rows = listAccounts();
  const next = rows.filter((a) => a.id !== id);
  if (next.length === rows.length) return false;
  writeAccounts(next);
  const secrets = readSecrets();
  delete secrets[id]; // never leave orphaned credentials behind
  writeSecrets(secrets);
  return true;
}

/** Account + preset + decrypted secret, for the protocol adapters. */
export function resolveAccount(id: string): ResolvedAccount | null {
  const account = getAccount(id);
  if (!account) return null;
  const preset = getPreset(account.presetId);
  if (!preset) return null;
  return { account, preset, secret: getSecret(id) };
}

/** Enabled accounts that speak a given protocol — drives tool parameters. */
export function accountsForProtocol(protocol: string): ConnectorAccount[] {
  return listAccounts().filter((a) => {
    if (!a.enabled) return false;
    const p = getPreset(a.presetId);
    return !!p?.protocols.includes(protocol as never);
  });
}

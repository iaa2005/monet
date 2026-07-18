/**
 * Connector accounts + secrets. Deliberately service-agnostic: this file knows
 * nothing about what a service IS — it persists (serviceId, username) rows and
 * encrypted opaque secrets, and that's all. Service knowledge lives in
 * services/; resolution glue lives in index.ts.
 *
 * Secrets are app passwords and tokens — full-access credentials — so they are
 * encrypted at rest with Electron safeStorage (DPAPI/Keychain/libsecret), the
 * same way LLM provider keys are, and kept in a SEPARATE file from the account
 * list so the list can be read and shown freely.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { getDataSubdir } from "../data-dir.js";
import type { ConnectorAccount, ConnectorSecret } from "./types.js";

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
 * Trim every string in a secret — ON WRITE ONLY.
 *
 * Credentials are pasted, and a paste brings company: an app password copied
 * out of a web page can drag a trailing newline along, and the server then
 * rejects a password the user can plainly see is correct.
 *
 * Cleaning what ARRIVES is fair. Rewriting what's already stored is not: a
 * read-side trim once "repaired" credentials the user never re-entered and a
 * working connector broke — a guess applied to data we cannot inspect. Never
 * again; getSecret returns stored bytes untouched.
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

/** Merge into the stored secret — persists a Telegram session or a refreshed
 * OAuth token without touching the rest. */
export function patchSecret(
  accountId: string,
  patch: Partial<ConnectorSecret>,
): void {
  setSecret(accountId, { ...getSecret(accountId), ...patch });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Add an account, or re-connect one.
 *
 * Two mailboxes are a real thing — work and personal — so a second account
 * under one service is allowed when the login differs. What is NOT allowed is
 * a silent twin: for `singleton` services (one server, one token — MCP) a
 * duplicate would quietly shadow the first, so it replaces instead. Same-login
 * and login-less (broken by construction) accounts always replace — the common
 * case is re-pasting an expired credential.
 */
export function addAccount(
  input: {
    presetId: string;
    label?: string;
    username: string;
    secret: ConnectorSecret;
  },
  opts?: { singleton?: boolean; defaultLabel?: string },
): ConnectorAccount {
  const username = input.username.trim();
  const existing = listAccounts().find(
    (a) =>
      a.presetId === input.presetId &&
      (opts?.singleton ||
        a.username.toLowerCase() === username.toLowerCase() ||
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
    label: input.label?.trim() || opts?.defaultLabel || input.presetId,
    username,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  writeAccounts([...listAccounts(), account]);
  setSecret(account.id, input.secret);
  return account;
}

/** Set (or clear, with null) one action's permission override. */
export function setAccountPermission(
  accountId: string,
  actionId: string,
  level: "allow" | "ask" | "deny" | null,
): ConnectorAccount | null {
  const rows = listAccounts();
  const i = rows.findIndex((a) => a.id === accountId);
  if (i < 0) return null;
  const permissions = { ...(rows[i].permissions ?? {}) };
  if (level === null) delete permissions[actionId];
  else permissions[actionId] = level;
  rows[i] = {
    ...rows[i],
    permissions: Object.keys(permissions).length ? permissions : undefined,
  };
  writeAccounts(rows);
  return rows[i];
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

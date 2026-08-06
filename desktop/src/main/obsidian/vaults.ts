/**
 * The vault registry — which Obsidian vaults the app knows about.
 *
 * A vault is a FOLDER THE USER OWNS, anywhere on disk — including inside a
 * cloud-sync folder, which is a supported case, not an accident. The app
 * never copies or moves it; the registry is just named pointers, stored in
 * <dataDir>/obsidian.json.
 *
 * Two flags per vault, both the user's to set:
 *   - enabled:  off means invisible — no tools, no directive, no index.
 *   - readOnly: the agent may search and read but VaultWrite refuses.
 *     For archives, for other people's vaults, for "look but don't touch".
 *
 * A real Obsidian vault has a `.obsidian/` folder; any folder of .md files
 * works though, so that is a HINT surfaced to the UI, not a requirement.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface VaultConfig {
  id: string;
  /** Display name — defaults to the folder's basename. */
  name: string;
  /** Absolute path of the vault folder. */
  path: string;
  enabled: boolean;
  readOnly: boolean;
  /**
   * Where THIS app puts attachments, overriding what the vault's own
   * `.obsidian/app.json` says. Empty means "ask the vault" — which for a
   * vault that has never been configured means the root, and a root full
   * of loose pictures is exactly what people ask to fix.
   */
  attachmentFolder?: string;
}

interface RegistryFile {
  vaults: VaultConfig[];
}

function registryPath(): string {
  return join(getDataDir(), "obsidian.json");
}

export function listVaults(): VaultConfig[] {
  try {
    const raw = readFileSync(registryPath(), "utf-8");
    const parsed = JSON.parse(raw) as RegistryFile;
    return Array.isArray(parsed.vaults) ? parsed.vaults : [];
  } catch {
    return [];
  }
}

function save(vaults: VaultConfig[]): void {
  writeFileSync(registryPath(), JSON.stringify({ vaults }, null, 2), "utf-8");
}

export function enabledVaults(): VaultConfig[] {
  return listVaults().filter((v) => v.enabled && existsSync(v.path));
}

export function hasEnabledVaults(): boolean {
  return enabledVaults().length > 0;
}

export function getVault(idOrName: string): VaultConfig | undefined {
  const k = idOrName.trim().toLowerCase();
  return listVaults().find(
    (v) => v.id === idOrName || v.name.toLowerCase() === k,
  );
}

/** True when the folder looks like a real Obsidian vault (has .obsidian/). */
export function looksLikeObsidianVault(path: string): boolean {
  try {
    return statSync(join(path, ".obsidian")).isDirectory();
  } catch {
    return false;
  }
}

export function addVault(path: string, name?: string): {
  ok: boolean;
  vault?: VaultConfig;
  error?: string;
} {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory())
      return { ok: false, error: "That path is not a folder." };
    const vaults = listVaults();
    const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (vaults.some((v) => norm(v.path) === norm(path)))
      return { ok: false, error: "That folder is already registered." };
    const base = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "vault";
    const vault: VaultConfig = {
      id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name?.trim() || base,
      path,
      enabled: true,
      readOnly: false,
    };
    save([...vaults, vault]);
    return { ok: true, vault };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function updateVault(
  id: string,
  patch: Partial<
    Pick<VaultConfig, "name" | "enabled" | "readOnly" | "attachmentFolder">
  >,
): { ok: boolean; error?: string } {
  const vaults = listVaults();
  const i = vaults.findIndex((v) => v.id === id);
  if (i < 0) return { ok: false, error: "No such vault." };
  vaults[i] = { ...vaults[i], ...patch };
  save(vaults);
  return { ok: true };
}

/** Forget the pointer. The folder and every note in it stay untouched —
 * deleting user data is not something a registry does. */
export function removeVault(id: string): { ok: boolean } {
  save(listVaults().filter((v) => v.id !== id));
  return { ok: true };
}

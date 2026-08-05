/**
 * Obsidian IPC — Settings → Obsidian: the vault registry and its statistics.
 *
 * Registering or toggling a vault changes which tools the model is offered
 * (VaultSearch/Read/Write are gated on an enabled vault existing), so every
 * mutation refreshes the vendor toolset the same way Memory's toggle does.
 */

import { ipcMain, shell } from "electron";
import { vaultStats } from "../obsidian/index.js";
import {
  addVault,
  listVaults,
  looksLikeObsidianVault,
  removeVault,
  updateVault,
  type VaultConfig,
} from "../obsidian/vaults.js";
import { resetVendorTools } from "../agent/vendor-tools.js";

export interface UiVault extends VaultConfig {
  /** Folder exists on disk right now (a cloud folder may be unmounted). */
  present: boolean;
  /** Has a `.obsidian/` folder — a hint, not a requirement. */
  isObsidian: boolean;
  stats: { notes: number; links: number; tags: number } | null;
}

function toUi(v: VaultConfig): UiVault {
  let present = false;
  let isObsidian = false;
  let stats: UiVault["stats"] = null;
  try {
    isObsidian = looksLikeObsidianVault(v.path);
    stats = vaultStats(v);
    present = true;
  } catch {
    present = false;
  }
  return { ...v, present, isObsidian, stats };
}

export function registerObsidianIPC(): void {
  ipcMain.handle("obsidian:list", (): UiVault[] => listVaults().map(toUi));
  ipcMain.handle("obsidian:add", (_e, path: string, name?: string) => {
    const r = addVault(path, name);
    if (r.ok) resetVendorTools();
    return r.ok ? { ...r, vault: r.vault && toUi(r.vault) } : r;
  });
  ipcMain.handle(
    "obsidian:update",
    (_e, id: string, patch: Partial<Pick<VaultConfig, "name" | "enabled" | "readOnly">>) => {
      const r = updateVault(id, patch);
      resetVendorTools();
      return r;
    },
  );
  ipcMain.handle("obsidian:remove", (_e, id: string) => {
    const r = removeVault(id);
    resetVendorTools();
    return r;
  });
  ipcMain.handle("obsidian:openFolder", (_e, id: string) => {
    const v = listVaults().find((x) => x.id === id);
    if (v) void shell.openPath(v.path);
    return { ok: !!v };
  });
}

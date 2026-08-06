/**
 * Obsidian IPC — Settings → Obsidian: the vault registry and its statistics.
 *
 * Registering or toggling a vault changes which tools the model is offered
 * (VaultSearch/Read/Write are gated on an enabled vault existing), so every
 * mutation refreshes the vendor toolset the same way Memory's toggle does.
 */

import { ipcMain, shell } from "electron";
import { join } from "path";
import {
  allNotes,
  buildGraph,
  resolveNote,
  vaultStats,
} from "../obsidian/index.js";
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

  // A [[wikilink]] clicked in the chat: name → the note file. The #heading
  // part is display-level; resolution works on the note.
  ipcMain.handle(
    "obsidian:resolve",
    (
      _e,
      ref: string,
    ): {
      ok: boolean;
      path?: string;
      name?: string;
      candidates?: { name: string; relPath: string; vaultName: string }[];
    } => {
      const bare = ref.replace(/#.*$/, "").trim();
      const notes = allNotes();
      const res = resolveNote(bare, notes);
      if (res.kind === "none") return { ok: false };
      if (res.kind === "many")
        return {
          ok: false,
          candidates: res.candidates.map((c) => ({
            name: c.name,
            relPath: c.relPath,
            vaultName: c.vaultName,
          })),
        };
      const vault = listVaults().find((v) => v.id === res.note.vaultId);
      if (!vault) return { ok: false };
      return {
        ok: true,
        name: res.note.name,
        path: join(vault.path, res.note.relPath),
      };
    },
  );

  // Do these wikilink targets exist? One batched call for a whole message —
  // the chat asks per RENDERED CHIP, and a streaming answer renders often,
  // so the renderer-side cache and batching (lib/vault-link-status.ts) are
  // part of this contract: this handler must stay cheap, not clever.
  ipcMain.handle(
    "obsidian:exists",
    (_e, refs: string[]): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      const list = Array.isArray(refs) ? refs.slice(0, 500) : [];
      if (list.length === 0) return out;
      const notes = allNotes();
      for (const ref of list) {
        const bare = String(ref).replace(/#.*$/, "").trim();
        out[ref] = resolveNote(bare, notes).kind !== "none";
      }
      return out;
    },
  );

  // The whole vault as nodes and edges, for the graph panel. Nodes carry
  // absolute paths so a click can open the note without a second round trip.
  ipcMain.handle("obsidian:graph", () => {
    const notes = allNotes();
    const { nodes, edges } = buildGraph(notes);
    const roots = new Map(listVaults().map((v) => [v.id, v.path]));
    return {
      nodes: nodes.map((n) => ({
        ...n,
        path: join(roots.get(n.id.split(":")[0]) ?? "", n.relPath),
      })),
      edges,
    };
  });

  // Ctrl+click: hand the note to the Obsidian app itself. The obsidian://
  // scheme is registered by Obsidian on install; without it the OS shows
  // its own "no app for this link" — honest enough, nothing to guess here.
  ipcMain.handle("obsidian:openInApp", (_e, absPath: string) => {
    void shell.openExternal(
      `obsidian://open?path=${encodeURIComponent(absPath)}`,
    );
    return { ok: true };
  });
}

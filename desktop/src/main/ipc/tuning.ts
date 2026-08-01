/**
 * Tuning IPC — advanced toggles + the tunable-prompts folder.
 *
 * Exposes the ToolSearch / LSP opt-in flags and the prompt-file controls
 * (reload the edited prompt files; open the folder — pre-seeding every prompt
 * so they all show up ready to edit).
 */

import { ipcMain, shell } from "electron";
import {
  getToolSearchConfig,
  setToolSearchConfig,
  type ToolSearchConfig,
} from "../agent/toolsearch-config.js";
import { getLspConfig, setLspConfig, type LspConfig } from "../agent/lsp/config.js";
import {
  getCavemanConfig,
  setCavemanConfig,
  type CavemanConfig,
} from "../agent/caveman.js";
import {
  getLeanConfig,
  setLeanConfig,
  type LeanConfig,
} from "../agent/lean-context.js";
import {
  getPowerConfig,
  setPowerConfig,
  isKeepingAwake,
  type PowerConfig,
} from "../power.js";
import { reloadPrompts, promptsDirPath } from "../prompts/index.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { seedTunablePrompts } from "../agent/index.js";

export function registerTuningIPC(): void {
  // Keep awake. `active` is the LIVE blocker, not the stored flag: if the OS
  // refused the block, the toggle must not claim otherwise.
  ipcMain.handle(
    "power:get",
    (): PowerConfig & { active: boolean } => ({
      ...getPowerConfig(),
      active: isKeepingAwake(),
    }),
  );
  ipcMain.handle(
    "power:set",
    (_e, patch: Partial<PowerConfig>): PowerConfig & { active: boolean } => {
      const next = setPowerConfig(patch);
      return { ...next, active: isKeepingAwake() };
    },
  );

  ipcMain.handle("toolsearch:get", (): ToolSearchConfig => getToolSearchConfig());
  ipcMain.handle(
    "toolsearch:set",
    (_e, patch: Partial<ToolSearchConfig>): ToolSearchConfig => {
      const next = setToolSearchConfig(patch);
      resetVendorTools(); // toolset advertisement changes (defer MCP + ToolSearch)
      return next;
    },
  );

  ipcMain.handle("caveman:get", (): CavemanConfig => getCavemanConfig());
  ipcMain.handle(
    "caveman:set",
    (_e, patch: Partial<CavemanConfig>): CavemanConfig => setCavemanConfig(patch),
  );

  ipcMain.handle("lean:get", (): LeanConfig => getLeanConfig());
  ipcMain.handle("lean:set", (_e, patch: Partial<LeanConfig>): LeanConfig => {
    const next = setLeanConfig(patch);
    // Tool descriptions are cached per tool-name set — drop it so the next
    // prompt is built with (or without) the trimmed versions.
    resetVendorTools();
    return next;
  });

  ipcMain.handle("lsp:get", (): LspConfig => getLspConfig());
  ipcMain.handle("lsp:set", (_e, patch: Partial<LspConfig>): LspConfig => {
    const next = setLspConfig(patch);
    resetVendorTools(); // LSP tool advertisement changes
    return next;
  });

  ipcMain.handle("prompts:reload", (): { ok: boolean } => {
    reloadPrompts();
    resetVendorTools(); // tool descriptions are cached with the API toolset
    return { ok: true };
  });

  ipcMain.handle(
    "prompts:reveal",
    async (): Promise<{ ok: boolean; dir: string }> => {
      await seedTunablePrompts(); // materialise every prompt file first
      const dir = promptsDirPath();
      await shell.openPath(dir);
      return { ok: true, dir };
    },
  );

  // Convert pre-transcript chats to durable (text-only) transcripts on demand.
}

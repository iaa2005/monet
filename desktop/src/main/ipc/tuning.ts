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
import { reloadPrompts, promptsDirPath } from "../prompts/index.js";
import { resetVendorTools } from "../agent/vendor-tools.js";
import { seedTunablePrompts } from "../agent/index.js";

export function registerTuningIPC(): void {
  ipcMain.handle("toolsearch:get", (): ToolSearchConfig => getToolSearchConfig());
  ipcMain.handle(
    "toolsearch:set",
    (_e, patch: Partial<ToolSearchConfig>): ToolSearchConfig => {
      const next = setToolSearchConfig(patch);
      resetVendorTools(); // toolset advertisement changes (defer MCP + ToolSearch)
      return next;
    },
  );

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
  ipcMain.handle(
    "transcripts:migrate",
    async (): Promise<{ migrated: number; skipped: number }> => {
      const { migrateTranscripts } = await import("../migrate-transcripts.js");
      return migrateTranscripts();
    },
  );
}

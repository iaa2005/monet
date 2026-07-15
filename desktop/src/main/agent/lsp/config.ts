/**
 * LSP configuration (opt-in).
 *
 * OFF by default: the LSP tool isn't advertised unless enabled, since it needs
 * external language servers installed (typescript-language-server, pyright,
 * gopls, rust-analyzer, clangd) and spawns them on use. Enable in lsp.json.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../../data-dir.js";

export interface LspConfig {
  enabled: boolean;
}

const DEFAULT: LspConfig = { enabled: false };

function configPath(): string {
  return join(getDataDir(), "lsp.json");
}

export function getLspConfig(): LspConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<LspConfig>;
    return { enabled: raw.enabled === true };
  } catch {
    return { ...DEFAULT };
  }
}

export function setLspConfig(patch: Partial<LspConfig>): LspConfig {
  const next = { ...getLspConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

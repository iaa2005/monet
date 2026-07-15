/**
 * ToolSearch configuration (opt-in).
 *
 * OFF by default: the toolset behaves exactly as before (all MCP tools
 * advertised, no ToolSearch tool). When ON, MCP connector tools are deferred
 * behind ToolSearch to save context — useful when many connectors are attached.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface ToolSearchConfig {
  enabled: boolean;
}

const DEFAULT: ToolSearchConfig = { enabled: false };

function configPath(): string {
  return join(getDataDir(), "toolsearch.json");
}

export function getToolSearchConfig(): ToolSearchConfig {
  try {
    const raw = JSON.parse(
      readFileSync(configPath(), "utf-8"),
    ) as Partial<ToolSearchConfig>;
    return { enabled: raw.enabled === true };
  } catch {
    return { ...DEFAULT };
  }
}

export function setToolSearchConfig(
  patch: Partial<ToolSearchConfig>,
): ToolSearchConfig {
  const next = { ...getToolSearchConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

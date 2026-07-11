/**
 * Computer Use config — the agent can control the mouse/keyboard and read the
 * screen only when the user opts in. `deniedApps` are foreground processes it
 * must refuse to act on (matched case-insensitively against the process name).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface ComputerConfig {
  enabled: boolean;
  deniedApps: string[];
}

const DEFAULT: ComputerConfig = { enabled: false, deniedApps: [] };

function configPath(): string {
  return join(getDataDir(), "computer.json");
}

export function getComputerConfig(): ComputerConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ComputerConfig>;
    return {
      enabled: !!raw.enabled,
      deniedApps: Array.isArray(raw.deniedApps)
        ? raw.deniedApps.filter((a): a is string => typeof a === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function setComputerConfig(
  patch: Partial<ComputerConfig>,
): ComputerConfig {
  const next = { ...getComputerConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

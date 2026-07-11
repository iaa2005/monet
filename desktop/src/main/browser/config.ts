/**
 * Browser Use config — the model can drive a managed browser only when the
 * user opts in (launching Chrome is heavy and outward-facing, like the
 * official app's "Browser Use" toggle).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export interface BrowserConfig {
  enabled: boolean;
}

const DEFAULT: BrowserConfig = { enabled: false };

function configPath(): string {
  return join(getDataDir(), "browser.json");
}

export function getBrowserConfig(): BrowserConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<BrowserConfig>;
    return { enabled: !!raw.enabled };
  } catch {
    return { ...DEFAULT };
  }
}

export function setBrowserConfig(patch: Partial<BrowserConfig>): BrowserConfig {
  const next = { ...getBrowserConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

/**
 * Sandbox configuration — which engine runs Home's generated code.
 *
 * Modular by design: the engine is chosen here and every caller goes through
 * runInSandbox(), so an engine can be fixed or disabled without touching the
 * agent or the UI.
 *
 *  - "pyodide"    : Python (+JS) in WebAssembly. Default. Isolated by
 *                   construction — no host filesystem or network.
 *  - "subprocess" : real python/node in a per-session temp dir. Opt-in, with a
 *                   loud warning: code runs on the user's machine WITHOUT hard
 *                   isolation.
 *  - "docker"     : reserved (not implemented yet).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

export type SandboxEngine = "pyodide" | "subprocess" | "docker";

export interface SandboxConfig {
  engine: SandboxEngine;
}

const DEFAULT: SandboxConfig = { engine: "pyodide" };

function configPath(): string {
  return join(getDataDir(), "sandbox.json");
}

export function getSandboxConfig(): SandboxConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<SandboxConfig>;
    const engine: SandboxEngine =
      raw.engine === "subprocess" || raw.engine === "docker"
        ? raw.engine
        : "pyodide";
    return { engine };
  } catch {
    return { ...DEFAULT };
  }
}

export function setSandboxConfig(patch: Partial<SandboxConfig>): SandboxConfig {
  const next = { ...getSandboxConfig(), ...patch };
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return next;
}

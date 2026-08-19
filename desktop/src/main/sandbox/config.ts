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

/**
 * The engine a fresh install runs on.
 *
 * macOS gets the host one, because there it is not the weaker choice: every
 * run goes through Seatbelt (sandbox-exec), which refuses writes outside the
 * chat's folder at the kernel. That buys real Python, real pip and a real
 * shell without the bargain the same engine makes on Windows and Linux, where
 * nothing fences it and Pyodide's WebAssembly walls are the safer default.
 */
const DEFAULT: SandboxConfig = {
  engine: process.platform === "darwin" ? "subprocess" : "pyodide",
};

function configPath(): string {
  return join(getDataDir(), "sandbox.json");
}

export function getSandboxConfig(): SandboxConfig {
  try {
    const p = configPath();
    if (!existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<SandboxConfig>;
    const engine: SandboxEngine =
      raw.engine === "subprocess" ||
      raw.engine === "docker" ||
      raw.engine === "pyodide"
        ? raw.engine
        : DEFAULT.engine;
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

// ─── Per-chat engine override ────────────────────────────────────────────────
//
// The engine above is the GLOBAL default. A chat may pin its own engine — its
// /work folder is engine-agnostic (a real host dir), so switching a chat's
// engine keeps its files; only the runtime changes. Stored as a flat
// sessionId → engine map, separate from the global default so clearing an
// override falls back to it.

function overridesPath(): string {
  return join(getDataDir(), "sandbox-sessions.json");
}

function readOverrides(): Record<string, SandboxEngine> {
  try {
    const p = overridesPath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    const out: Record<string, SandboxEngine> = {};
    for (const [id, v] of Object.entries(raw))
      if (v === "pyodide" || v === "subprocess" || v === "docker")
        out[id] = v;
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(map: Record<string, SandboxEngine>): void {
  try {
    writeFileSync(overridesPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** The engine a specific chat runs on: its override, else the global default. */
export function getSessionEngine(sessionId: string): SandboxEngine {
  const ov = readOverrides()[sessionId];
  return ov ?? getSandboxConfig().engine;
}

/** Does the chat have an explicit override (vs. inheriting the global default)? */
export function getSessionEngineOverride(sessionId: string): SandboxEngine | null {
  return readOverrides()[sessionId] ?? null;
}

/** Pin a chat to an engine, or pass null to clear the override (inherit global). */
export function setSessionEngine(
  sessionId: string,
  engine: SandboxEngine | null,
): SandboxEngine {
  const map = readOverrides();
  if (engine === null) delete map[sessionId];
  else map[sessionId] = engine;
  writeOverrides(map);
  return getSessionEngine(sessionId);
}

/** Drop a chat's override — called when the chat is deleted. */
export function clearSessionEngine(sessionId: string): void {
  const map = readOverrides();
  if (sessionId in map) {
    delete map[sessionId];
    writeOverrides(map);
  }
}

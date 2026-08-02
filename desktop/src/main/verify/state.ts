/**
 * Verification config and the known-red memory — the electron-side half.
 *
 * Split from loop.ts so the loop stays importable under plain node for the
 * probe; everything that touches the data dir lives here.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import type { KnownRedStore } from "./loop.js";

export interface VerifyConfig {
  /** The whole feature. On by default — automation the user must ask for
   * isn't automation. */
  enabled: boolean;
  maxAttempts: number;
}

const DEFAULTS: VerifyConfig = { enabled: true, maxAttempts: 3 };

const configFile = (): string => join(getDataDir(), "verify-config.json");

export function getVerifyConfig(): VerifyConfig {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf-8")) as Partial<VerifyConfig>;
    const attempts = Number(j.maxAttempts);
    return {
      enabled: j.enabled !== false,
      maxAttempts: Number.isFinite(attempts)
        ? Math.min(Math.max(Math.round(attempts), 1), 10)
        : DEFAULTS.maxAttempts,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setVerifyConfig(patch: Partial<VerifyConfig>): VerifyConfig {
  const next = { ...getVerifyConfig(), ...patch };
  writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** Signatures per workspace. Small caps: this is a memo, not a database. */
const MAX_SIGNATURES = 8;
const MAX_WORKSPACES = 20;

interface StateFile {
  knownRed: Record<string, { signatures: string[]; updatedAt: number }>;
}

const stateFile = (): string => join(getDataDir(), "verify-state.json");

function readState(): StateFile {
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<StateFile>;
    return { knownRed: j.knownRed ?? {} };
  } catch {
    return { knownRed: {} };
  }
}

function writeState(state: StateFile): void {
  try {
    const entries = Object.entries(state.knownRed)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_WORKSPACES);
    writeFileSync(
      stateFile(),
      JSON.stringify({ knownRed: Object.fromEntries(entries) }, null, 2),
      "utf-8",
    );
  } catch {
    /* a lost memo costs one wasted fix turn, nothing more */
  }
}

/** The known-red store for one workspace, persisted across restarts —
 * a failure the user's own code carries shouldn't cost a fix turn per send. */
export function knownRedFor(cwd: string): KnownRedStore {
  return {
    has(signature: string): boolean {
      return readState().knownRed[cwd]?.signatures.includes(signature) ?? false;
    },
    add(signature: string): void {
      const state = readState();
      const cur = state.knownRed[cwd]?.signatures ?? [];
      if (!cur.includes(signature)) cur.push(signature);
      state.knownRed[cwd] = {
        signatures: cur.slice(-MAX_SIGNATURES),
        updatedAt: Date.now(),
      };
      writeState(state);
    },
    clear(): void {
      const state = readState();
      if (!state.knownRed[cwd]) return;
      delete state.knownRed[cwd];
      writeState(state);
    },
  };
}

/**
 * Central application data directory.
 *
 * Everything the app persists (sessions DB, providers, settings, and the
 * vendored Claude Code config/memory via CLAUDE_CONFIG_DIR) lives under one
 * folder. By default that is a `.monet` folder next to the `desktop/` project
 * in dev, or `<userData>/.monet` when packaged. The location is overridable and
 * the override is stored in a tiny bootstrap file in userData.
 */
import { app } from "electron";
import { DOT_DIR } from "@shared/brand.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const BOOTSTRAP_FILE = (): string =>
  join(app.getPath("userData"), "monet-bootstrap.json");

function defaultDataDir(): string {
  if (!app.isPackaged) {
    // Dev: sibling of the desktop/ folder → <repo>/.monet
    return join(dirname(app.getAppPath()), DOT_DIR);
  }
  return join(app.getPath("userData"), DOT_DIR);
}

let cached: string | null = null;

function readOverride(): string | null {
  // An env override beats the stored one, and is never written back. This is
  // how a test run gets its OWN data dir: the alternative — pointing the
  // bootstrap file at a temp folder — changes where the user's real app
  // keeps its chats, and a probe that crashes before restoring it would
  // leave them looking at an empty install.
  const fromEnv = process.env.MONET_DATA_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  try {
    const f = BOOTSTRAP_FILE();
    if (existsSync(f)) {
      const cfg = JSON.parse(readFileSync(f, "utf-8")) as { dataDir?: string };
      if (typeof cfg.dataDir === "string" && cfg.dataDir.trim())
        return cfg.dataDir;
    }
  } catch {
    /* ignore malformed bootstrap */
  }
  return null;
}

/** Absolute path to the active data directory (created if missing). */
export function getDataDir(): string {
  if (cached) return cached;
  const dir = readOverride() ?? defaultDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  cached = dir;
  return dir;
}

/** A named subdirectory inside the data dir (created if missing). */
export function getDataSubdir(name: string): string {
  const d = join(getDataDir(), name);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** Persist a new data directory override. Requires an app restart to fully apply. */
export function setDataDir(dir: string): void {
  writeFileSync(BOOTSTRAP_FILE(), JSON.stringify({ dataDir: dir }, null, 2));
  cached = null;
}

export function isDefaultDataDir(): boolean {
  return readOverride() === null;
}

/**
 * Point the vendored Claude Code code (memory, config, ~/.claude writes) at our
 * data dir via the env var it already respects. Call once at startup.
 */
export function applyDataDirEnv(): void {
  const dir = join(getDataDir(), "claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  process.env["CLAUDE_CONFIG_DIR"] = dir;
}

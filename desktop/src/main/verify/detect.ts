/**
 * Which checks does this project already have?
 *
 * The verification loop's whole premise is that the user writes NOTHING: no
 * skill, no config, no list of commands. So the commands come from what the
 * project itself declares — package.json scripts, a Cargo.toml, a go.mod —
 * and never from the model, which keeps "the harness runs commands on its
 * own" bounded by what the user's own project already tells any developer
 * to run.
 *
 * Checks come in two tiers. "fast" (typecheck, lint) runs after every turn
 * that edited files — it has to be cheap or the whole feature teaches the
 * user to turn it off. "full" (test, build) is reserved for moments that
 * warrant it: judging whether a goal is really complete.
 *
 * No electron imports here — the probe runs this under plain node.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface VerifyCheck {
  /** Short name shown in the UI and to the model ("typecheck", "cargo check"). */
  name: string;
  /** Full shell command, run from the workspace root. */
  command: string;
  /** fast = after every edited turn; full = only when a goal is judged. */
  tier: "fast" | "full";
  timeoutMs: number;
}

const FAST_TIMEOUT_MS = 120_000;
const FULL_TIMEOUT_MS = 420_000;

/** package.json script names worth running, in the order they should run. */
const SCRIPT_TIERS: { key: string; tier: VerifyCheck["tier"] }[] = [
  { key: "typecheck", tier: "fast" },
  { key: "lint", tier: "fast" },
  { key: "test", tier: "full" },
  { key: "build", tier: "full" },
];

function packageManager(cwd: string): string {
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")))
    return "bun run";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm run";
}

function nodeChecks(cwd: string): VerifyCheck[] {
  const pkgFile = join(cwd, "package.json");
  if (!existsSync(pkgFile)) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts =
      (JSON.parse(readFileSync(pkgFile, "utf-8")) as { scripts?: Record<string, unknown> })
        .scripts ?? {};
  } catch {
    return [];
  }
  const pm = packageManager(cwd);
  const out: VerifyCheck[] = [];
  for (const { key, tier } of SCRIPT_TIERS) {
    const body = scripts[key];
    if (typeof body !== "string" || !body.trim()) continue;
    // `npm init` plants a "test" script whose job is to fail. Running it would
    // make every project look broken.
    if (body.includes("no test specified")) continue;
    out.push({
      name: key,
      command: `${pm} ${key}`,
      tier,
      timeoutMs: tier === "fast" ? FAST_TIMEOUT_MS : FULL_TIMEOUT_MS,
    });
  }
  // A project with a "check" script and no "typecheck" (svelte-check, biome)
  // still deserves a fast gate.
  if (!out.some((c) => c.tier === "fast") && typeof scripts["check"] === "string")
    out.unshift({
      name: "check",
      command: `${pm} check`,
      tier: "fast",
      timeoutMs: FAST_TIMEOUT_MS,
    });
  return out;
}

function cargoChecks(cwd: string): VerifyCheck[] {
  if (!existsSync(join(cwd, "Cargo.toml"))) return [];
  return [
    { name: "cargo check", command: "cargo check --quiet", tier: "fast", timeoutMs: FAST_TIMEOUT_MS },
    { name: "cargo test", command: "cargo test --quiet", tier: "full", timeoutMs: FULL_TIMEOUT_MS },
  ];
}

function goChecks(cwd: string): VerifyCheck[] {
  if (!existsSync(join(cwd, "go.mod"))) return [];
  return [
    { name: "go vet", command: "go vet ./...", tier: "fast", timeoutMs: FAST_TIMEOUT_MS },
    { name: "go build", command: "go build ./...", tier: "full", timeoutMs: FULL_TIMEOUT_MS },
  ];
}

/** Manifests whose mtimes invalidate the cache — the answer only changes when
 * one of these does. */
const MANIFESTS = [
  "package.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.toml",
  "go.mod",
];

function stampFor(cwd: string): string {
  return MANIFESTS.map((f) => {
    try {
      return String(statSync(join(cwd, f)).mtimeMs);
    } catch {
      return "-";
    }
  }).join("|");
}

const cache = new Map<string, { stamp: string; checks: VerifyCheck[] }>();

/** All checks the workspace declares, cached until a manifest changes. */
export function detectChecks(cwd: string): VerifyCheck[] {
  if (!cwd) return [];
  const stamp = stampFor(cwd);
  const hit = cache.get(cwd);
  if (hit && hit.stamp === stamp) return hit.checks;
  const checks = [...nodeChecks(cwd), ...cargoChecks(cwd), ...goChecks(cwd)];
  cache.set(cwd, { stamp, checks });
  return checks;
}

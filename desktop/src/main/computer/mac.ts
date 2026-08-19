/**
 * The macOS Computer Use helper — compile-on-first-use, then a plain CLI.
 *
 * The Windows implementation drives user32/UIA/WinRT through PowerShell so
 * nothing native ships with the app. macOS has no PowerShell, but it has the
 * next best thing: a Swift compiler on every machine with the Xcode Command
 * Line Tools. One source file (resources/mac-computer/monet-mac.swift) is
 * compiled once into <dataDir>/mac-computer/ and reused; a source change is
 * detected by size+mtime and triggers a rebuild.
 *
 * Everything here degrades to a clear error instead of a crash: no swiftc →
 * "install the Command Line Tools", no Accessibility permission → the
 * caller sees `accessibility-not-granted` and can point the user at System
 * Settings.
 */

import { execFile, spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { getDataSubdir } from "../data-dir.js";

function sourcePath(): string {
  const packaged = join(process.resourcesPath ?? "", "mac-computer", "monet-mac.swift");
  if (existsSync(packaged)) return packaged;
  return join(app.getAppPath(), "resources", "mac-computer", "monet-mac.swift");
}

let building: Promise<string | null> | null = null;
let builtPath: string | null | undefined;

function stamp(p: string): string {
  try {
    const s = statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return "?";
  }
}

/** Absolute path to the compiled helper, or null with a logged reason. */
export function macHelperBinary(): Promise<string | null> {
  if (builtPath !== undefined && builtPath !== null) return Promise.resolve(builtPath);
  if (!building) building = build();
  return building;
}

async function build(): Promise<string | null> {
  const dir = getDataSubdir("mac-computer");
  const src = sourcePath();
  const bin = join(dir, "monet-mac");
  const receipt = join(dir, "source.stamp");
  try {
    if (existsSync(bin) && existsSync(receipt)) {
      const { readFileSync } = await import("fs");
      if (readFileSync(receipt, "utf-8") === stamp(src)) {
        builtPath = bin;
        return bin;
      }
    }
  } catch {
    /* rebuild */
  }

  const probe = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.warn(
      "[mac-computer] swiftc not found — install the Xcode Command Line Tools (xcode-select --install) to enable Computer Use",
    );
    builtPath = null;
    building = null;
    return null;
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Compile beside the final name, then move into place — a crash mid-compile
  // must not leave a half-written binary that later "works".
  const tmp = join(dir, `monet-mac.build-${process.pid}`);
  console.log("[mac-computer] compiling helper (first use, ~1 min)…");
  const res = spawnSync("swiftc", ["-O", "-o", tmp, src], {
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  if (res.status !== 0 || !existsSync(tmp)) {
    console.warn(`[mac-computer] compile failed:\n${(res.stderr || "").slice(0, 2000)}`);
    builtPath = null;
    building = null;
    return null;
  }
  copyFileSync(tmp, bin);
  const { rmSync, writeFileSync, chmodSync } = await import("fs");
  chmodSync(bin, 0o755);
  rmSync(tmp, { force: true });
  writeFileSync(receipt, stamp(src), "utf-8");
  console.log(`[mac-computer] helper ready at ${bin}`);
  builtPath = bin;
  return bin;
}

export interface MacRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one helper subcommand. Non-zero exit or a missing helper → ok:false. */
export async function runMac(args: string[], timeoutMs = 15_000): Promise<MacRunResult> {
  const bin = await macHelperBinary();
  if (!bin) {
    return {
      ok: false,
      stdout: "",
      stderr:
        "Computer Use on macOS needs the Xcode Command Line Tools (xcode-select --install).",
    };
  }
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Permission snapshot: Accessibility (input + AX tree) and Screen Recording
 * (window titles, screenshots). Both are granted per-app in System Settings →
 * Privacy & Security. */
export async function macPermissions(): Promise<{ ax: boolean; screen: boolean }> {
  const r = await runMac(["check"], 10_000);
  try {
    const v = JSON.parse(r.stdout) as { ax?: boolean; screen?: boolean };
    return { ax: !!v.ax, screen: !!v.screen };
  } catch {
    return { ax: false, screen: false };
  }
}

/**
 * Portable Podman provisioning — so the user installs nothing.
 *
 * Resolution order for the podman CLI directory:
 *   1. bundled with the app (resources/podman/bin — dev, or
 *      <resourcesPath>/podman/bin — packaged),
 *   2. previously downloaded into <dataDir>/podman/bin,
 *   3. downloaded on demand from the official GitHub release (the portable
 *      windows zip, which contains podman.exe + gvproxy.exe + win-sshproxy.exe
 *      that `podman machine` needs).
 *
 * Whichever exists is prepended to PATH, so the engine's plain `spawn("podman")`
 * finds it. The WSL2 machine backend that `podman machine` sets up on first use
 * is inherent to running Linux containers on Windows and can't be bundled.
 */

import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";

const PODMAN_VERSION = process.env.PODMAN_VERSION || "5.4.1";
// The Windows portable client zip (podman.exe + gvproxy.exe + win-sshproxy.exe
// for `podman machine`). The asset name has no version, so it's stable.
const ZIP_URL = `https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-release-windows_amd64.zip`;

function bundledCandidates(): string[] {
  const dirs: string[] = [];
  try {
    // Packaged: electron-builder extraResources → <resourcesPath>/podman/…
    dirs.push(join(process.resourcesPath, "podman"));
  } catch {
    /* not packaged */
  }
  // Dev: repo resources/podman/…
  dirs.push(join(app.getAppPath(), "resources", "podman"));
  dirs.push(join(app.getAppPath(), "..", "resources", "podman"));
  return dirs;
}

/** Recursively find the directory that directly contains podman.exe. */
function findPodmanBin(root: string, depth = 0): string | null {
  if (!existsSync(root) || depth > 6) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  if (entries.includes("podman.exe")) return root;
  for (const e of entries) {
    const full = join(root, e);
    try {
      if (statSync(full).isDirectory()) {
        const hit = findPodmanBin(full, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function appPodmanRoot(): string {
  return getDataSubdir("podman");
}

/** The dir containing podman.exe (bundled or downloaded), or null. */
export function podmanBinDir(): string | null {
  for (const c of bundledCandidates()) {
    const hit = findPodmanBin(c);
    if (hit) return hit;
  }
  return findPodmanBin(appPodmanRoot());
}

let pathPatched = false;
export function addPodmanToPath(): boolean {
  const dir = podmanBinDir();
  if (!dir) return false;
  if (!pathPatched) {
    process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
    pathPatched = true;
    console.log(`[podman] using portable CLI at ${dir}`);
  }
  return true;
}

function ps(script: string, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "-"],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

let downloading: Promise<{ ok: boolean; error?: string }> | null = null;

/** Ensure the portable podman CLI exists and is on PATH. Downloads it on the
 * first Podman use (Windows only; elsewhere we rely on a system podman). */
export async function ensurePodmanBinary(): Promise<{ ok: boolean; error?: string }> {
  if (addPodmanToPath()) return { ok: true };
  if (process.platform !== "win32")
    return { ok: false, error: "No bundled Podman; install podman from your package manager." };
  if (!downloading) downloading = downloadPodman();
  const r = await downloading;
  if (!r.ok) downloading = null;
  return r;
}

async function downloadPodman(): Promise<{ ok: boolean; error?: string }> {
  try {
    const root = appPodmanRoot();
    const tmpZip = join(root, `podman-${PODMAN_VERSION}.zip`);
    const extractDir = join(root, "extract");
    if (!existsSync(root)) mkdirSync(root, { recursive: true });

    console.log(`[podman] downloading portable CLI: ${ZIP_URL}`);
    const res = await fetch(ZIP_URL, { redirect: "follow" });
    if (!res.ok)
      return { ok: false, error: `Download failed: HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpZip, buf);

    rmSync(extractDir, { recursive: true, force: true });
    const ok = await ps(
      `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${extractDir}' -Force`,
    );
    if (!ok) return { ok: false, error: "Failed to unzip the Podman archive." };

    const srcBin = findPodmanBin(extractDir);
    if (!srcBin)
      return { ok: false, error: "podman.exe not found in the archive." };

    // Copy the whole bin dir (podman.exe + gvproxy.exe + win-sshproxy.exe).
    const destBin = join(root, "bin");
    if (!existsSync(destBin)) mkdirSync(destBin, { recursive: true });
    for (const f of readdirSync(srcBin)) {
      try {
        if (statSync(join(srcBin, f)).isFile())
          copyFileSync(join(srcBin, f), join(destBin, f));
      } catch {
        /* skip */
      }
    }
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(tmpZip, { force: true });

    if (!addPodmanToPath())
      return { ok: false, error: "Podman downloaded but couldn't be located." };
    console.log("[podman] portable CLI installed");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

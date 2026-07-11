/**
 * Podman engine — real Python/Node/LaTeX inside an isolated container.
 *
 * The image (python:3.12-slim + nodejs + tectonic + common science wheels)
 * is built ONCE from the embedded Containerfile and shared by every chat —
 * containers are copy-on-write layers over it, so per-chat cost is megabytes,
 * not gigabytes. Each run mounts the chat's sandbox folder at /work (the same
 * folder the subprocess engine uses, so files survive engine switches) plus a
 * shared pip-cache volume so repeated installs are fast.
 *
 * Requires Podman (on Windows: `podman machine init && podman machine start`).
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataSubdir } from "../data-dir.js";
import { snapshotFiles } from "./subprocess-engine.js";
import {
  MAX_STREAM_CHARS,
  SANDBOX_TIMEOUT_MS,
  type EngineResult,
  type SandboxFile,
} from "./types.js";

const IMAGE_TAG = "monet-sandbox:latest";
const BUILD_TIMEOUT_MS = 15 * 60_000;

const CONTAINERFILE = `
FROM docker.io/library/python:3.12-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends nodejs npm curl ca-certificates fontconfig \\
 && rm -rf /var/lib/apt/lists/*
# Tectonic: a self-contained LaTeX engine (~40MB) that fetches TeX packages
# on demand — full texlive (multi-GB) is deliberately avoided.
RUN curl -fsSL https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz \\
    | tar -xz -C /usr/local/bin tectonic \\
 || echo "tectonic install failed - LaTeX unavailable in this image"
RUN pip install --no-cache-dir fpdf2 python-docx openpyxl matplotlib pandas
WORKDIR /work
`.trimStart();

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const dir = join(getDataSubdir("sandboxes"), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function run(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn("podman", args, {
      cwd: opts.cwd,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (!done) {
        stderr += `\n[sandbox] killed after ${(opts.timeoutMs ?? SANDBOX_TIMEOUT_MS) / 1000}s`;
        child.kill();
      }
    }, opts.timeoutMs ?? SANDBOX_TIMEOUT_MS);
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_STREAM_CHARS) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_STREAM_CHARS) stderr += d.toString();
    });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: e.message });
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let imageReady = false;

async function ensureImage(): Promise<{ ok: boolean; log: string; error?: string }> {
  if (imageReady) return { ok: true, log: "" };

  const probe = await run(["--version"], { timeoutMs: 15_000 });
  if (probe.spawnError || probe.code !== 0) {
    return {
      ok: false,
      log: "",
      error:
        "Podman is not available. Install it (https://podman.io) and on Windows run: podman machine init && podman machine start. Or switch the Sandbox engine in Settings.",
    };
  }

  const exists = await run(["image", "exists", IMAGE_TAG], { timeoutMs: 30_000 });
  if (exists.code === 0) {
    imageReady = true;
    return { ok: true, log: "" };
  }

  // First use: build the shared image (one-time, minutes).
  const build = await run(
    ["build", "-t", IMAGE_TAG, "-f", "-", "."],
    { stdin: CONTAINERFILE, timeoutMs: BUILD_TIMEOUT_MS, cwd: getDataSubdir("sandboxes") },
  );
  if (build.code !== 0) {
    return {
      ok: false,
      log: "",
      error:
        `Failed to build the sandbox image:\n${(build.stderr || build.stdout).slice(-600)}` +
        (build.stderr.includes("connect") || build.stderr.includes("machine")
          ? "\nHint: is the podman machine running? (podman machine start)"
          : ""),
    };
  }
  imageReady = true;
  return { ok: true, log: "[sandbox] built container image (one-time)\n" };
}

export async function runPodman(
  sessionId: string,
  code: string,
): Promise<EngineResult> {
  const image = await ensureImage();
  if (!image.ok) {
    return { ok: false, stdout: "", stderr: "", files: [], error: image.error };
  }

  const dir = sessionDir(sessionId);
  const before = snapshotFiles(dir);
  const scriptName = `_run_${Date.now()}.py`;
  writeFileSync(join(dir, scriptName), code, "utf-8");

  const result = await run([
    "run",
    "--rm",
    "-v",
    `${dir}:/work`,
    "-v",
    "monet-pip-cache:/root/.cache/pip",
    "-w",
    "/work",
    "-e",
    "PYTHONIOENCODING=utf-8",
    "-e",
    "PYTHONUTF8=1",
    IMAGE_TAG,
    "python",
    scriptName,
  ]);
  if (result.spawnError) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      files: [],
      error: `Podman failed to run: ${result.spawnError}`,
    };
  }

  const after = snapshotFiles(dir);
  const files: SandboxFile[] = [];
  for (const [name, sig] of after) {
    if (name === scriptName || name.startsWith("_run_")) continue;
    if (before.get(name) === sig) continue;
    try {
      files.push({ name, bytes: readFileSync(join(dir, name)) });
    } catch {
      /* skip */
    }
  }

  return {
    ok: result.code === 0,
    stdout: image.log + result.stdout,
    stderr: result.stderr,
    files,
  };
}

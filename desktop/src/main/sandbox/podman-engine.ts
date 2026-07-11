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

function decodeWindowsOutput(data: Buffer): string {
  if (process.platform !== "win32") return data.toString("utf8");
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return data.toString("utf16le").slice(1);
  // wsl.exe writes UTF-16LE by default. Podman wraps it in an ASCII prefix
  // ending with "exit status N (…)". Split at the last '(' when the suffix
  // has UTF-16LE high bytes; decode each half with its own encoding.
  const p = data.lastIndexOf(0x28); // '('
  if (p >= 0 && data.length - p > 2) {
    const tail = data.subarray(p + 1);
    let hi = 0;
    for (let i = 1; i < tail.length; i += 2)
      if (tail[i] >= 0x04 && tail[i] <= 0x09) hi++;
    if (hi >= 3)
      return data.subarray(0, p + 1).toString("utf8") + tail.toString("utf16le");
  }
  return data.toString("utf8");
}

function run(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let done = false;
    const child = spawn("podman", args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    const timer = setTimeout(() => {
      if (!done) {
        stderrChunks.push(Buffer.from(`\n[sandbox] killed after ${(opts.timeoutMs ?? SANDBOX_TIMEOUT_MS) / 1000}s`, "utf8"));
        child.kill();
      }
    }, opts.timeoutMs ?? SANDBOX_TIMEOUT_MS);
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.stdout.on("data", (d: Buffer) => {
      if (stdoutLength < MAX_STREAM_CHARS) {
        stdoutChunks.push(d);
        stdoutLength += d.length;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderrLength < MAX_STREAM_CHARS) {
        stderrChunks.push(d);
        stderrLength += d.length;
      }
    });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      const stdout = decodeWindowsOutput(Buffer.concat(stdoutChunks).subarray(0, MAX_STREAM_CHARS));
      const stderr = decodeWindowsOutput(Buffer.concat(stderrChunks).subarray(0, MAX_STREAM_CHARS));
      resolve({ code: null, stdout, stderr, spawnError: e.message });
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      const stdout = decodeWindowsOutput(Buffer.concat(stdoutChunks).subarray(0, MAX_STREAM_CHARS));
      const stderr = decodeWindowsOutput(Buffer.concat(stderrChunks).subarray(0, MAX_STREAM_CHARS));
      resolve({ code, stdout, stderr });
    });
  });
}

let imageReady = false;
let podmanReady: Promise<{ ok: boolean; log: string; error?: string }> | null = null;

async function ensurePodman(): Promise<{ ok: boolean; log: string; error?: string }> {
  if (!podmanReady) podmanReady = initializePodman();
  const result = await podmanReady;
  if (!result.ok) podmanReady = null;
  return result;
}

async function initializePodman(): Promise<{ ok: boolean; log: string; error?: string }> {
  const probe = await run(["--version"], { timeoutMs: 15_000 });
  if (probe.spawnError || probe.code !== 0) {
    return {
      ok: false,
      log: "",
      error:
        "Podman is not available. Install it (https://podman.io), or switch the Sandbox engine in Settings.",
    };
  }

  if (process.platform === "win32") {
    const machines = await run(
      ["machine", "list", "--format", "{{.Name}}\t{{.Running}}"],
      { timeoutMs: 30_000 },
    );
    if (machines.code !== 0) {
      return {
        ok: false,
        log: "",
        error: `Podman machine status failed:\n${(machines.stderr || machines.stdout).slice(-600)}`,
      };
    }

    const machine = machines.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .find(([name]) => name);
    let log = "";
    if (!machine) {
      const init = await run(["machine", "init"], { timeoutMs: 120_000 });
      if (init.code !== 0) {
        return {
          ok: false,
          log: "",
          error: `Podman machine initialization failed:\n${(init.stderr || init.stdout).slice(-600)}`,
        };
      }
      log += "[sandbox] initialized Podman machine\n";
    }

    const machineName = machine?.[0];
    const running = machine?.[1]?.toLowerCase() === "true";
    if (!running) {
      const startArgs = ["machine", "start"];
      if (machineName) startArgs.push(machineName);
      const start = await run(startArgs, { timeoutMs: 120_000 });
      if (start.code !== 0) {
        return {
          ok: false,
          log: "",
          error: `Podman machine start failed:\n${(start.stderr || start.stdout).slice(-600)}`,
        };
      }
      log += "[sandbox] started Podman machine\n";
    }

    const info = await run(["info"], { timeoutMs: 30_000 });
    if (info.code !== 0) {
      return {
        ok: false,
        log: "",
        error: `Podman is not ready:\\n${(info.stderr || info.stdout).slice(-600)}`,
      };
    }
    return { ok: true, log };
  }

  const info = await run(["info"], { timeoutMs: 30_000 });
  if (info.code !== 0) {
    return {
      ok: false,
      log: "",
      error: `Podman is not ready:\\n${(info.stderr || info.stdout).slice(-600)}`,
    };
  }
  return { ok: true, log: "" };
}

async function ensureImage(): Promise<{ ok: boolean; log: string; error?: string }> {
  if (imageReady) return { ok: true, log: "" };

  const podman = await ensurePodman();
  if (!podman.ok) return podman;

  const exists = await run(["image", "exists", IMAGE_TAG], { timeoutMs: 30_000 });
  if (exists.code === 0) {
    imageReady = true;
    return { ok: true, log: podman.log };
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
  return {
    ok: true,
    log: podman.log + "[sandbox] built container image (one-time)\n",
  };
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

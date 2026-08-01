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

// Bump the tag when the Containerfile changes — ensureImage() skips the build
// when the tag already exists, so a new tag forces the updated image.
const IMAGE_TAG = "monet-sandbox:v2";
const BUILD_TIMEOUT_MS = 15 * 60_000;
// RunCommand (tectonic, npm, etc.) gets a longer leash than RunPython.
const RUN_COMMAND_TIMEOUT_MS = 5 * 60_000;
// `machine init` downloads a ~900 MB VM image. The old 4-minute cap killed it
// mid-copy on an ordinary connection, and a half-written machine is worse than
// no machine — it registers a WSL distro that later blocks a clean init.
const INIT_TIMEOUT_MS = 20 * 60_000;

const CONTAINERFILE = `
FROM docker.io/library/python:3.12-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends nodejs npm curl ca-certificates \\
    fontconfig fonts-dejavu fonts-dejavu-extra fonts-liberation \\
 && rm -rf /var/lib/apt/lists/*
# Tectonic: a self-contained LaTeX engine (~40MB) that fetches TeX packages
# on demand — full texlive (multi-GB) is deliberately avoided.
RUN curl -fsSL https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz \\
    | tar -xz -C /usr/local/bin tectonic \\
 || echo "tectonic install failed - LaTeX unavailable in this image"
RUN pip install --no-cache-dir fpdf2 python-docx openpyxl matplotlib pandas numpy Pillow
WORKDIR /work
`.trimStart();

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session";
  const dir = join(getDataSubdir("sandboxes"), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The host path mounted at /work for a chat — the sandbox's working folder,
 * with its real directory structure (for the Home Files tree). */
export function sandboxWorkDir(sessionId: string): string {
  return sessionDir(sessionId);
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

/**
 * The machine's real name, out of `machine list` output.
 *
 * `{{.Name}}` renders the DEFAULT machine with a trailing asterisk —
 * "podman-machine-default*" — and that marker is part of the field, not of
 * the table formatting. Passing it back to podman produced the failure a user
 * hit again and again:
 *
 *   podman machine start podman-machine-default*
 *   Error: open ...\machine\wsl\podman-machine-default*.json: The filename,
 *   directory name, or volume label syntax is incorrect.
 *
 * Windows rejects `*` in a path (error 123); the app reported that as "the
 * machine is damaged and needs to be rebuilt", so the user was told to delete
 * a perfectly healthy machine — while Settings, which only asks `podman
 * info`, kept saying "Podman is ready". It bites only once the machine has
 * stopped (an idle WSL machine shuts itself down), because a running one
 * never reaches `machine start`.
 */
export function machineName(raw: string | undefined): string | undefined {
  const name = raw?.trim().replace(/\*+$/, "").trim();
  return name || undefined;
}

/**
 * Podman's own chatter, out of anything a user reads.
 *
 * These lines print on SUCCESSFUL starts too — they are about Docker API
 * forwarding, and podman says so itself two lines later ("Podman clients are
 * still able to connect"). Quoted back inside a failure they read like the
 * cause: a user was shown "could not start api proxy since expected pipe is
 * not available" as the headline of a problem it had nothing to do with, and
 * concluded their machine was broken. The real line — "machine did not
 * transition into running state" — was buried under it.
 */
export function stripPodmanNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/api forwarding for docker api clients/i.test(line) &&
        !/could not start api proxy/i.test(line) &&
        !/podman clients are still able to connect/i.test(line) &&
        !/docker api clients default to this address/i.test(line) &&
        !/you do not need to set docker_host/i.test(line),
    )
    .join("\n")
    .trim();
}

/**
 * One clean stop→start cycle — the recovery for a machine that reports
 * running while its socket is dead (an idle WSL distro that lost its tunnel).
 *
 * `machine stop` returns before the distro has actually gone, and starting
 * into that gap is how a recovery turns into "already running" and leaves the
 * machine exactly as wedged as before. So the stop is followed by waiting for
 * podman to admit the machine is down, not by a fixed guess.
 *
 * Verified by hand against a really wedged machine: stop → settle → start
 * brings the socket back every time, with nothing killed and nothing rebuilt.
 */
async function stopThenStart(
  name: string | undefined,
  tryStart: () => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
  }>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stopArgs = ["machine", "stop"];
  if (name) stopArgs.push(name);
  await run(stopArgs, { timeoutMs: 60_000 });
  // Up to ~20s for the distro to report itself down; usually one or two ticks.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const list = await machineList();
    const running = list.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .find(([n]) => n)?.[1]
      ?.toLowerCase();
    if (running !== "true") break;
  }
  // Podman can report a clean stop while the WSL distro is still up — and a
  // distro that outlives the stop is the whole wedge: the next start writes a
  // new SSH port that the surviving sshd never hears about. `wsl --terminate`
  // is a power-off, not a delete: the disk, the images and the containers are
  // all still there afterwards.
  if (await distroRunning(name)) await terminateDistro(name);
  return tryStart();
}

/** Whether the machine's WSL distro is up, whatever podman believes. */
async function distroRunning(name: string | undefined): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const distro = name || "podman-machine-default";
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-l", "-v"], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
    child.on("error", () => resolve(false));
    child.on("close", () => {
      const line = out
        .split(/\r?\n/)
        .map((l) => l.replace(/\0/g, "").trim())
        .find((l) => l.replace(/^\*\s*/, "").startsWith(distro));
      resolve(!!line && /running/i.test(line));
    });
  });
}

function terminateDistro(name: string | undefined): Promise<void> {
  const distro = name || "podman-machine-default";
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["--terminate", distro], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    child.on("error", () => resolve());
    child.on("close", () => setTimeout(resolve, 1_500));
  });
}

type PodmanReadyResult = {
  ok: boolean;
  log: string;
  error?: string;
  /** True when the failure is specifically a missing/disabled WSL2 backend. */
  needsWsl?: boolean;
};

/** Poll `podman info` until the API socket accepts connections, or timeout.
 * Tight cadence so we detect "socket up" within ~1s of it happening (the boot
 * itself is the floor; don't add detection lag on top). */
async function waitForPodmanReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await run(["info"], { timeoutMs: 8_000 });
    if (info.code === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** The WSL distros podman owns, as `wsl -l -q` reports them. */
function wslPodmanDistros(): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-l", "-q"], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    let out = "";
    child.stdout?.on("data", (b) => (out += b.toString()));
    child.on("error", () => resolve([]));
    child.on("close", () =>
      resolve(
        out
          .split(/\r?\n/)
          .map((s) => s.replace(/\0/g, "").trim())
          .filter((s) => s.startsWith("podman-machine")),
      ),
    );
  });
}

function wslUnregister(distro: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["--unregister", distro], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The names in podman's *system connection* registry (a json file under
 * AppData, separate from the machines themselves).
 *
 * These outlive the machine they point at. `machine init` refuses to reuse a
 * name that still has a connection — "system connection ... already exists" —
 * so a machine that is gone from `machine list` can still block its own
 * recreation, with no VM and no distro anywhere to explain why.
 */
async function podmanConnections(): Promise<string[]> {
  const r = await run(["system", "connection", "ls", "--format", "{{.Name}}"], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "name");
}

async function removeConnection(name: string): Promise<boolean> {
  const r = await run(["system", "connection", "rm", name], {
    timeoutMs: 30_000,
  });
  return r.code === 0;
}

/**
 * `machine init` reported "already exists" while `machine list` shows nothing.
 * Something from a previous machine outlived the machine itself, and every
 * start from here fails identically, forever.
 *
 * There are TWO independent leftovers, and either one alone is enough to block
 * init — an interrupted first-time setup can leave one, the other, or both:
 *
 *   - a WSL distro with no podman config addressing it, and
 *   - an entry in podman's system connection registry, which lives in a
 *     separate file under AppData and is NOT touched by `wsl --unregister`.
 *
 * Clearing only the distro was this function's original bug: on a machine whose
 * distro was already gone the loop below did nothing, init failed with the very
 * same "system connection ... already exists", and the repair reported that
 * error as if it had tried something. Clear both.
 *
 * From Settings the user asked for a repair, so clear and rebuild. From a tool
 * call, say what is wrong and what fixes it — and say plainly that retrying
 * will not, because the alternative is an agent that runs the same doomed
 * command a dozen times.
 */
/** The four commands the repair issues, injectable so the probe can drive the
 * whole sequence without a podman install (and assert the ORDER — clearing the
 * connection after `machine init` would be useless). */
export type OrphanRepairDeps = {
  listDistros: () => Promise<string[]>;
  unregister: (distro: string) => Promise<boolean>;
  listConnections: () => Promise<string[]>;
  removeConnection: (name: string) => Promise<boolean>;
  init: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
};

const liveRepairDeps: OrphanRepairDeps = {
  listDistros: wslPodmanDistros,
  unregister: wslUnregister,
  listConnections: podmanConnections,
  removeConnection,
  init: () => run(["machine", "init"], { timeoutMs: INIT_TIMEOUT_MS }),
};

export async function orphanedMachineFailure(
  canRepair: boolean,
  deps: OrphanRepairDeps = liveRepairDeps,
): Promise<PodmanReadyResult> {
  const distros = await deps.listDistros();
  const connections = await deps.listConnections();

  if (!canRepair) {
    const leftovers = [
      distros.length ? `a leftover WSL virtual machine (${distros[0]})` : "",
      connections.length
        ? `a stale podman connection (${connections[0]})`
        : "",
    ].filter(Boolean);
    return {
      ok: false,
      log: "",
      error:
        "The Podman sandbox cannot start: " +
        (leftovers.join(" and ") || "leftover state from a previous machine") +
        " is blocking it, while the machine itself is gone — most likely an " +
        "interrupted first-time setup.\n" +
        "RETRYING THIS TOOL WILL NOT HELP. Either open Settings → Sandbox and " +
        "press Prepare to rebuild the machine (it downloads ~1 GB, several " +
        "minutes), or switch the sandbox engine to Pyodide or Local " +
        "subprocess and do the work there.",
    };
  }

  let log = "";
  for (const distro of distros) {
    log += `[sandbox] unregistering orphaned WSL distro ${distro}\n`;
    if (!(await deps.unregister(distro)))
      return {
        ok: false,
        log,
        error:
          `Could not remove the leftover WSL machine ${distro}. Close any ` +
          "open WSL shells and try Prepare again, or run " +
          `\`wsl --unregister ${distro}\` yourself.`,
      };
  }

  // Safe to drop unconditionally: we only get here with `machine list` empty,
  // so every one of these addresses a machine that no longer exists. `machine
  // init` recreates the pair it needs.
  for (const name of connections) {
    log += `[sandbox] removing stale podman connection ${name}\n`;
    if (!(await deps.removeConnection(name)))
      return {
        ok: false,
        log,
        error:
          `Could not remove the stale podman connection ${name}. Run ` +
          `\`podman system connection rm ${name}\` yourself, then press ` +
          "Prepare again.",
      };
  }

  const init = await deps.init();
  if (init.code !== 0)
    return {
      ok: false,
      log,
      error: `Podman machine initialization failed:\n${(init.stderr || init.stdout).slice(-600)}`,
    };
  log += "[sandbox] rebuilt the Podman machine\n";
  return { ok: true, log };
}

/** Whether the WSL2 backend exists at all (Windows). ENOENT/non-zero ⇒ missing. */
function wslInstalled(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(true);
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["--status"], {
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: "1" },
    });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 15_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  });
}

let imageReady = false;
let podmanReady: Promise<PodmanReadyResult> | null = null;
let podmanReadyState = false;
// Latches once Podman has worked this session. The WSL2 VM idle-freezes / the
// socket forwarder dies between runs, so "socket down right now" doesn't mean
// "broken" — RunPython restarts it on demand. Passive UI uses this latch to
// avoid nagging after a successful setup.
let podmanEverReady = false;

export function isPodmanReady(): boolean {
  return podmanReadyState;
}

let warmInFlight: Promise<unknown> | null = null;

/**
 * Kick off machine start (and image check) in the BACKGROUND so the VM is warm
 * by the time the user runs code — the cold WSL2 boot then happens off the
 * critical path. Fire-and-forget and deduped; a no-op once ready. Called when a
 * Home chat opens so the wait is hidden behind reading/typing.
 */
export function warmPodman(): void {
  if (podmanReadyState || warmInFlight) return;
  warmInFlight = ensureImage()
    .catch(() => {})
    .finally(() => {
      warmInFlight = null;
    });
}

/**
 * Lightweight, NON-destructive readiness probe: does the API socket answer?
 * Unlike checkPodmanReady() this never inits/starts/restarts the machine, so
 * it is safe to call on every chat mount / message send without wedging the VM.
 */
export async function podmanInfoOk(): Promise<boolean> {
  const info = await run(["info"], { timeoutMs: 10_000 });
  const ok = info.code === 0;
  podmanReadyState = ok;
  if (ok) podmanEverReady = true;
  return ok;
}

/**
 * For passive UI (Home banner / Settings status): true if Podman works now, or
 * worked earlier this session — since RunPython transparently restarts the
 * wedged/idle machine, an earlier success means it will work again on demand.
 */
export async function podmanLikelyReady(): Promise<boolean> {
  if (podmanEverReady) return true;
  return podmanInfoOk();
}

/** Called when user clicks Install/prepare in Settings. Allows broken-machine reset. */
export async function checkPodmanReady(): Promise<PodmanReadyResult> {
  const binary = await import("./podman-binary.js").then((m) => m.ensurePodmanBinary());
  if (!binary.ok) {
    podmanReadyState = false;
    return { ...binary, log: "" };
  }
  // Drop any cached failure so we re-check from scratch.
  podmanReady = null;
  const result = await initializePodman({ resetOnBroken: true });
  podmanReadyState = result.ok;
  if (result.ok) {
    podmanEverReady = true;
    podmanReady = Promise.resolve(result);
  }
  return result;
}

async function ensurePodman(): Promise<PodmanReadyResult> {
  // The machine can wedge (running but socket dead) or idle-stop between runs,
  // so a cached success goes stale. Cheaply re-verify the socket; only fall
  // through to a full (re)initialize — which stop→start recovers — when gone.
  if (podmanReady) {
    const cached = await podmanReady;
    if (cached.ok && (await podmanInfoOk())) return cached;
    podmanReady = null;
  }
  podmanReady = initializePodman();
  const result = await podmanReady;
  if (!result.ok) podmanReady = null;
  return result;
}

/**
 * Machine status, retried through the transient failures.
 *
 * Podman rewrites its machine JSON while it works, and a `machine list` that
 * lands mid-write reports "unable to read machine config … .json" — a real
 * error message about a perfectly healthy machine. Reported raw it reads as
 * corruption: a model diagnosed exactly that and told the user to delete
 * their machine and rebuild it, while Settings still said "Podman is ready"
 * (the socket was fine the whole time). Two short retries cost a second and
 * turn that into nothing at all.
 */
export const TRANSIENT_MACHINE_ERROR =
  /unable to read|unexpected end of json|invalid character|used by another process|resource busy|lock/i;

async function machineList(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}> {
  const once = (): ReturnType<typeof run> =>
    run(["machine", "list", "--format", "{{.Name}}\t{{.Running}}"], {
      timeoutMs: 30_000,
    });
  let last = await once();
  for (let i = 0; i < 2 && last.code !== 0; i++) {
    if (!TRANSIENT_MACHINE_ERROR.test(last.stderr || last.stdout || "")) break;
    await new Promise((r) => setTimeout(r, 500));
    last = await once();
  }
  return last;
}

async function initializePodman(opts: { resetOnBroken?: boolean } = {}): Promise<PodmanReadyResult> {
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
    const machines = await machineList();
    if (machines.code !== 0) {
      return {
        ok: false,
        log: "",
        error: `Podman machine status failed:\n${(machines.stderr || machines.stdout).slice(-600)}`,
      };
    }

    let log = "";
    let resolvedName: string | undefined;
    let running = false;

    const parseName = (): string | undefined => {
      const m = machines.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .find(([name]) => name);
      return machineName(m?.[0]);
    };
    resolvedName = parseName();
    running = machines.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .find(([name]) => name)?.[1]?.toLowerCase() === "true";

    if (!resolvedName) {
      const init = await run(["machine", "init"], { timeoutMs: INIT_TIMEOUT_MS });
      if (init.code !== 0) {
        const msg = (init.stderr || init.stdout).toLowerCase();
        if (msg.includes("already exists")) {
          // init says the machine is there but list didn't report it. Two very
          // different causes, so ASK rather than assume: re-list and believe
          // that. If list now names it, the first read was an encoding/format
          // hiccup. If list is still empty, the WSL distro outlived podman's
          // config for it — usually a `machine init` killed partway through —
          // and every later start will say "VM does not exist". Assuming
          // success here is what turned that into an endless loop.
          const recheck = await run(
            ["machine", "list", "--format", "{{.Name}}"],
            { timeoutMs: 30_000 },
          );
          const named = recheck.stdout
            .trim()
            .split(/\r?\n/)
            .find((n) => n.trim());
          if (named) {
            resolvedName = machineName(named);
            log += "[sandbox] Podman machine already present\n";
          } else {
            const repair = await orphanedMachineFailure(
              opts.resetOnBroken === true,
            );
            if (!repair.ok) return repair;
            resolvedName = "podman-machine-default";
            log += repair.log;
          }
        } else {
          return {
            ok: false,
            log: "",
            error: `Podman machine initialization failed:\n${(init.stderr || init.stdout).slice(-600)}`,
          };
        }
      } else {
        resolvedName = "podman-machine-default";
        log += "[sandbox] initialized Podman machine\n";
      }
    }

    // Classify any hard failure: a missing WSL2 backend gets a specific flag so
    // the UI can show the right instructions instead of a generic error.
    const fail = async (error: string): Promise<PodmanReadyResult> => ({
      ok: false,
      log,
      error,
      needsWsl: !(await wslInstalled()),
    });

    /**
     * Start the machine — but never one that is already up.
     *
     * `machine start` re-provisions the SSH port: it writes a fresh port into
     * the machine config and points clients at it. On a machine that is
     * ALREADY running, the distro is left alone, so sshd keeps listening on
     * the previous port while every client dials the new one — connection
     * refused, forever, from a machine that was working a second earlier.
     * Caught in the field with the ports side by side: config said 45597,
     * sshd inside the distro was still on 41021.
     *
     * So the API is asked first. If it answers, there is nothing to start.
     */
    const tryStart = async (): Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      spawnError?: string;
    }> => {
      if (await podmanInfoOk())
        return { code: 0, stdout: "[sandbox] machine already serving", stderr: "" };
      const startArgs = ["machine", "start"];
      if (resolvedName) startArgs.push(resolvedName);
      return run(startArgs, { timeoutMs: 180_000 });
    };

    // Start the machine unless it already reports running. A non-zero exit here
    // isn't necessarily fatal — a machine wedged "Currently starting" reports an
    // error yet can still settle, and the readiness poll below recovers it.
    let start = running ? { code: 0, stdout: "", stderr: "" } : await tryStart();
    // A path-shaped complaint means the NAME was wrong, not the machine: that
    // is what a stray default-machine marker produced for a year. The name is
    // sanitized now (machineName), so this is the belt to that braces — retry
    // once with no name at all, letting podman pick its own default, before
    // anyone concludes the VM is damaged.
    if (start.code !== 0 && /\*\.json|syntax is incorrect/i.test(start.stderr || start.stdout)) {
      const nameless = await run(["machine", "start"], { timeoutMs: 180_000 });
      if (nameless.code === 0) {
        resolvedName = undefined;
        start = nameless;
      }
    }
    if (start.code !== 0) {
      const msg = (start.stderr || start.stdout).toLowerCase();
      const looksBroken =
        msg.includes("no such file") ||
        msg.includes("syntax is incorrect") ||
        msg.includes("*.json");
      if (looksBroken && opts.resetOnBroken !== true) {
        // Drop the latch. `podmanEverReady` exists because the WSL VM idle-
        // freezes and the socket dies between runs, so "not answering right
        // now" does not mean broken — but a machine that says its own config
        // file is unreadable IS broken, and that is better evidence than the
        // latch. Reported: the sandbox refused every run with this very message
        // while Settings kept saying "Podman is ready", because the latch had
        // been set by a working session earlier and nothing ever cleared it.
        podmanEverReady = false;
        podmanReadyState = false;
        // Destroying the machine is a repair, not a side effect of running a
        // command: `machine rm -f` throws away the VM, and if the `machine
        // init` behind it doesn't finish, the sandbox is left with nothing and
        // no way back. It only happens from Settings → Sandbox, where a person
        // asked for it and can watch the ~1 GB image download.
        return fail(
          "The Podman machine is damaged and needs to be rebuilt. Open " +
            "Settings → Sandbox and press Prepare — it removes the broken " +
            "machine and downloads a fresh one (several minutes). Meanwhile " +
            "switch the sandbox engine to Pyodide or Local subprocess.\n" +
            `Podman said:\n${stripPodmanNoise(
              start.stderr || start.stdout,
            ).slice(-400)}`,
        );
      }
      if (looksBroken) {
        log += "[sandbox] resetting broken Podman machine\n";
        await run(["machine", "rm", "-f"], { timeoutMs: 60_000 });
        resolvedName = undefined;
        const init = await run(["machine", "init"], {
          timeoutMs: INIT_TIMEOUT_MS,
        });
        if (init.code !== 0) {
          // `machine rm -f` removes the machine, but a machine that was already
          // half-gone leaves its system connection behind, and init then refuses
          // the name. Same orphan state as below — repair it rather than
          // reporting podman's line and stopping. We are inside resetOnBroken,
          // so the repair is already authorised.
          if ((init.stderr || init.stdout).toLowerCase().includes("already exists")) {
            const repair = await orphanedMachineFailure(true);
            if (!repair.ok) return { ...repair, log: log + repair.log };
            log += repair.log;
          } else {
            return fail(
              `Podman machine initialization failed after reset:\n${(init.stderr || init.stdout).slice(-600)}`,
            );
          }
        } else {
          log += "[sandbox] re-initialized Podman machine\n";
        }
        resolvedName = "podman-machine-default";
        start = await tryStart();
      } else {
        log += "[sandbox] machine start reported an error; verifying readiness\n";
      }
    }

    // A machine that reports "running" — or has just started — may still have an
    // unconnectable API socket for a few seconds, or be wedged half-started.
    // Poll the socket; if it never comes up, do one clean stop→start recovery.
    // A machine that already claimed "running" but has a dead socket is wedged,
    // so give it only a short grace; a freshly started one may need longer.
    const firstPollMs = running ? 15_000 : 45_000;
    if (!(await waitForPodmanReady(firstPollMs))) {
      log += "[sandbox] socket unreachable — restarting the Podman machine\n";
      const restart = await stopThenStart(resolvedName, tryStart);
      // The wedge that produced "could not start api proxy since expected pipe
      // is not available" + "machine did not transition into running state":
      // the WSL distro is up (list says running) but its ssh tunnel is dead,
      if (!(await waitForPodmanReady(60_000))) {
        const why = (restart.stderr || restart.stdout).toLowerCase();
        // "VM does not exist" after a start means the machine podman listed is
        // a ghost: the config names it, the backend has nothing behind it.
        // Echoing podman's line here is what left the agent with no next step.
        if (why.includes("does not exist"))
          return orphanedMachineFailure(opts.resetOnBroken === true);
        return fail(
          restart.code !== 0
            ? `Podman machine failed to start:\n${stripPodmanNoise(
                restart.stderr || restart.stdout,
              ).slice(-600)}`
            : "Podman started but its API socket never became reachable. Try `podman machine stop` then `podman machine start`, or restart the app.",
        );
      }
    }
    log += "[sandbox] Podman machine ready\n";
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
  // The machine is checked on EVERY run, even when the image is known.
  //
  // This latch used to skip ensurePodman() entirely, and that is why a
  // wedged machine looked unfixable: the first run of a session warmed the
  // latch, the WSL machine idled out an hour later, and every run after that
  // failed with a raw podman error while the recovery code sat behind the
  // early return. Retrying was useless by construction — which is exactly
  // what the user reported, three variations of the same dead end.
  //
  // ensurePodman is cheap when things are fine: one `podman info` against a
  // live socket. When they are not, it is the thing that heals them.
  const podman = await ensurePodman();
  if (!podman.ok) return podman;
  if (imageReady) return { ok: true, log: "" };

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

/** The image tag the sandbox runs — the preview server shares the image. */
export { IMAGE_TAG };

/**
 * Build the image if needed. Exported for podman-server.ts, which starts a
 * long-lived container from the same image the one-shot runs use.
 */
export async function ensureSandboxImage(): Promise<{
  ok: boolean;
  log: string;
  error?: string;
}> {
  return ensureImage();
}

/**
 * Raw `podman <args>` — for callers that manage their own container lifecycle
 * (the preview server: run -d, logs, rm). The one-shot runners above wrap this
 * with file snapshotting; this one hands back the process result untouched.
 */
export function podmanExec(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return run(args, opts);
}

export async function runPodmanCommand(
  sessionId: string,
  command: string,
): Promise<EngineResult> {
  const image = await ensureImage();
  if (!image.ok) return { ok: false, stdout: "", stderr: "", files: [], error: image.error };
  const dir = sessionDir(sessionId);
  const before = snapshotFiles(dir);
  const result = await run([
    "run", "--rm", "-v", `${dir}:/work`, "-v", "monet-pip-cache:/root/.cache/pip",
    "-w", "/work", IMAGE_TAG, "sh", "-lc", command,
  ], { timeoutMs: RUN_COMMAND_TIMEOUT_MS });
  // Surface any files the command wrote into /work, same as RunPython — so
  // e.g. `python3 -c "...save('out.png')"` shows up as an artifact.
  const after = snapshotFiles(dir);
  const files: SandboxFile[] = [];
  for (const [name, sig] of after) {
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
    error: result.spawnError,
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

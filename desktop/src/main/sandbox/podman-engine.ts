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

    let log = "";
    let resolvedName: string | undefined;
    let running = false;

    const parseName = (): string | undefined => {
      const m = machines.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .find(([name]) => name);
      return m?.[0];
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
            resolvedName = named.trim();
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

    const tryStart = (): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> => {
      const startArgs = ["machine", "start"];
      if (resolvedName) startArgs.push(resolvedName);
      return run(startArgs, { timeoutMs: 180_000 });
    };

    // Start the machine unless it already reports running. A non-zero exit here
    // isn't necessarily fatal — a machine wedged "Currently starting" reports an
    // error yet can still settle, and the readiness poll below recovers it.
    let start = running ? { code: 0, stdout: "", stderr: "" } : await tryStart();
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
            `Podman said:\n${(start.stderr || start.stdout).slice(-400)}`,
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
      const stopArgs = ["machine", "stop"];
      if (resolvedName) stopArgs.push(resolvedName);
      await run(stopArgs, { timeoutMs: 60_000 });
      const restart = await tryStart();
      if (!(await waitForPodmanReady(60_000))) {
        const why = (restart.stderr || restart.stdout).toLowerCase();
        // "VM does not exist" after a start means the machine podman listed is
        // a ghost: the config names it, the backend has nothing behind it.
        // Echoing podman's line here is what left the agent with no next step.
        if (why.includes("does not exist"))
          return orphanedMachineFailure(opts.resetOnBroken === true);
        return fail(
          restart.code !== 0
            ? `Podman machine failed to start:\n${(restart.stderr || restart.stdout).slice(-600)}`
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

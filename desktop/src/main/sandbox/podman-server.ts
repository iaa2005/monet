/**
 * Serving a Home chat's sandbox over HTTP — the isolated way.
 *
 * Home had no honest way to show a page in the browser. The model reached for
 * the DevServer tool (meant for the user's Code workspace), which spawned
 * `python -m http.server` on the HOST with cwd = the workspace root — so a
 * chat that is supposed to be isolated from the machine published the whole
 * project directory, `.git` and the app's own data folder included, on every
 * network interface. Then, to make the page load at all, it copied its file
 * OUT of the sandbox into the repository. Both halves of that are exactly
 * what Home exists to prevent.
 *
 * Here the server runs INSIDE the sandbox container:
 *
 *   - the document root is /work — the chat's own folder and nothing else,
 *     so a path traversal reaches container files, never the user's;
 *   - the port is published as `127.0.0.1:host:container`, so it answers on
 *     this machine only; the LAN cannot see it. The container-side bind is
 *     0.0.0.0 by necessity (that is the container's own namespace) — the
 *     host-side address is what decides who can reach it;
 *   - one server per chat, named after the chat, `--rm`, and stopped when the
 *     chat's sandbox is reset, when the app quits, or on request. Nothing
 *     outlives the app holding a port.
 *
 * Requires the Podman engine. Pyodide has no sockets and the subprocess engine
 * is not isolated at all, so neither may serve — the tool says so plainly.
 */

import { spawn } from "child_process";
import { createConnection } from "net";
import {
  ensureSandboxImage,
  IMAGE_TAG,
  podmanExec,
  sandboxWorkDir,
} from "./podman-engine.js";

/** Where published ports start. Above the usual dev-server range so a Home
 * preview never fights the user's own 3000/5173/8080. */
const PORT_BASE = 8730;
const PORT_TRIES = 40;
/** How long to wait for the server inside the container to answer. */
const READY_TIMEOUT_MS = 20_000;

export interface SandboxServer {
  sessionId: string;
  /** Container name — derived from the chat id, so it is findable after a
   * main-process restart even though the map is gone. */
  container: string;
  /** Host port, bound to 127.0.0.1 only. */
  port: number;
  /** Port the command listens on INSIDE the container. */
  containerPort: number;
  command: string;
  url: string;
  startedAt: number;
}

const servers = new Map<string, SandboxServer>();

function containerName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "chat";
  return `monet-serve-${safe}`;
}

function portOpenOn(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** A host port nobody is listening on. Checked on 127.0.0.1 — the only
 * address we ever publish to. */
async function freePort(): Promise<number | null> {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = PORT_BASE + i;
    if (servers.size > 0 && [...servers.values()].some((s) => s.port === port))
      continue;
    if (!(await portOpenOn("127.0.0.1", port, 200))) return port;
  }
  return null;
}

async function waitUntilServing(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpenOn("127.0.0.1", port, 300)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * The argv for the serving container.
 *
 * Split out so the safety-critical parts — the loopback-only publish, /work as
 * the only mount, no host network — can be asserted without Podman installed
 * (scripts/sandbox-server-probe.ts).
 */
export function serveArgs(opts: {
  container: string;
  dir: string;
  hostPort: number;
  containerPort: number;
  command: string;
}): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    opts.container,
    // The chat's folder, and nothing else from the host.
    "-v",
    `${opts.dir}:/work`,
    "-w",
    "/work",
    // Host side is loopback ONLY. Container side is 0.0.0.0 because that is
    // the container's own namespace, which is not reachable from anywhere
    // except through this publish.
    "-p",
    `127.0.0.1:${opts.hostPort}:${opts.containerPort}`,
    // The same persistent pip target the run containers use: a server like
    // `jupyter notebook` must see what a previous RunCommand pip-installed.
    "-e",
    "PIP_TARGET=/work/.pip",
    "-e",
    "PYTHONPATH=/work/.pip",
    "-e",
    "PATH=/work/.pip/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    IMAGE_TAG,
    "sh",
    "-lc",
    opts.command,
  ];
}

/** The default command: a static file server over the chat's folder. */
export function staticServeCommand(containerPort: number): string {
  return `python3 -m http.server ${containerPort} --bind 0.0.0.0`;
}

export function getSandboxServer(sessionId: string): SandboxServer | null {
  return servers.get(sessionId) ?? null;
}

export function listSandboxServers(): SandboxServer[] {
  return [...servers.values()];
}

export async function startSandboxServer(
  sessionId: string,
  opts: { command?: string; containerPort?: number } = {},
): Promise<{ ok: boolean; server?: SandboxServer; error?: string; log?: string }> {
  const running = servers.get(sessionId);
  if (running) return { ok: true, server: running };

  const image = await ensureSandboxImage();
  if (!image.ok) return { ok: false, error: image.error ?? "Sandbox image unavailable." };

  const containerPort = opts.containerPort ?? 8000;
  const command = opts.command ?? staticServeCommand(containerPort);
  const hostPort = await freePort();
  if (hostPort == null)
    return { ok: false, error: "No free local port in the preview range." };

  const container = containerName(sessionId);
  // A container from a previous run of the app still holds the name (and its
  // port). Remove it before claiming the name again.
  await podmanExec(["rm", "-f", container], { timeoutMs: 15_000 });

  const started = await podmanExec(
    serveArgs({
      container,
      dir: sandboxWorkDir(sessionId),
      hostPort,
      containerPort,
      command,
    }),
    { timeoutMs: 60_000 },
  );
  if (started.code !== 0) {
    return {
      ok: false,
      error: started.stderr.trim() || started.spawnError || "Podman refused to start the container.",
    };
  }

  if (!(await waitUntilServing(hostPort, READY_TIMEOUT_MS))) {
    const log = await sandboxServerLogs(sessionId, 40, container);
    await podmanExec(["rm", "-f", container], { timeoutMs: 15_000 });
    return {
      ok: false,
      error: `The server did not answer on 127.0.0.1:${hostPort} within ${READY_TIMEOUT_MS / 1000}s.`,
      log,
    };
  }

  const server: SandboxServer = {
    sessionId,
    container,
    port: hostPort,
    containerPort,
    command,
    url: `http://127.0.0.1:${hostPort}/`,
    startedAt: Date.now(),
  };
  servers.set(sessionId, server);
  return { ok: true, server };
}

export async function stopSandboxServer(sessionId: string): Promise<boolean> {
  const server = servers.get(sessionId);
  const name = server?.container ?? containerName(sessionId);
  servers.delete(sessionId);
  const r = await podmanExec(["rm", "-f", name], { timeoutMs: 20_000 });
  return r.code === 0;
}

export async function sandboxServerLogs(
  sessionId: string,
  lines = 60,
  container?: string,
): Promise<string> {
  const name = container ?? servers.get(sessionId)?.container ?? containerName(sessionId);
  const r = await podmanExec(["logs", "--tail", String(lines), name], {
    timeoutMs: 15_000,
  });
  return [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * Stop every preview container. Called on quit — synchronous-ish best effort,
 * because `will-quit` does not await promises: the detached `podman rm -f`
 * outlives us long enough to do its job, and `--rm` plus the name collision
 * check on the next start covers whatever it misses.
 */
export function stopAllSandboxServers(): void {
  for (const [sessionId, server] of servers) {
    servers.delete(sessionId);
    try {
      spawn("podman", ["rm", "-f", server.container], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      /* podman gone — the container dies with its --rm anyway */
    }
  }
}

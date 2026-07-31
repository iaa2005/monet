/**
 * Dev servers you declare once and start from the Browser panel.
 *
 * Detection (dev-servers.ts) answers "what is already listening". This answers
 * "what should be listening, and is it" — a named thing you can start, stop,
 * and point the panel at without remembering the port.
 *
 * The config lives in the WORKSPACE, at .monet/servers.json, beside the other
 * per-project agent files. A dev server belongs to a project, not to a chat or
 * to this machine, and a file in the repo is one somebody else on the team gets
 * for free.
 *
 * Two things here are less obvious than they look, and both are in the comments
 * where they bite: what counts as "running", and what it takes to stop one.
 */

import { spawn, type ChildProcess } from "child_process";
import { createConnection } from "net";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import treeKill from "tree-kill";
import { DOT_DIR } from "@shared/brand.js";

export interface ServerConfig {
  id: string;
  name: string;
  /** Run through a shell, so `npm run dev` works as typed. */
  command: string;
  /** Relative to the workspace when set. */
  cwd?: string;
  port: number;
}

export type ServerStatus = "stopped" | "starting" | "running" | "failed";

export interface ServerState extends ServerConfig {
  status: ServerStatus;
  /** Why it failed, when it did. */
  error?: string;
  startedAt?: number;
  /** True when something answers on the port, whoever started it. */
  externallyRunning?: boolean;
  /**
   * The port it ACTUALLY took, when that is not the one declared.
   *
   * Vite, Next and CRA all move to the next free port and say so; the declared
   * number is a wish, and the server's own output is the fact.
   */
  actualPort?: number;
  /**
   * False for a server we merely FOUND — the agent ran `npm run dev`, or you
   * did in a terminal. It has no entry in the project file, so there is no
   * command to start it with and nothing of ours to stop.
   */
  declared: boolean;
}

// ─── Config file ──────────────────────────────────────────────────────────

function configPath(workspace: string): string {
  return join(workspace, DOT_DIR, "servers.json");
}

/**
 * Parse a servers file.
 *
 * Exported for the probe: this reads a file a human edits by hand, so every
 * field has to survive being absent, misspelled or the wrong type without
 * taking the panel down with it.
 */
export function parseServers(json: string): ServerConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { servers?: unknown })?.servers)
      ? (raw as { servers: unknown[] }).servers
      : [];
  const out: ServerConfig[] = [];
  for (const item of list) {
    // A null or a bare string in the array is not an entry. Reading through it
    // throws, and one throw here empties the whole panel.
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<ServerConfig>;
    const port = Number(s.port);
    if (typeof s.command !== "string" || !s.command.trim()) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({
      id: typeof s.id === "string" && s.id ? s.id : `srv-${out.length + 1}`,
      name:
        typeof s.name === "string" && s.name.trim()
          ? s.name.trim()
          : `:${port}`,
      command: s.command.trim(),
      ...(typeof s.cwd === "string" && s.cwd ? { cwd: s.cwd } : {}),
      port,
    });
  }
  return out;
}

export function readServers(workspace: string): ServerConfig[] {
  try {
    return parseServers(readFileSync(configPath(workspace), "utf-8"));
  } catch {
    return [];
  }
}

export function writeServers(workspace: string, servers: ServerConfig[]): void {
  const path = configPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ servers }, null, 2)}\n`, "utf-8");
}

/**
 * Servers worth offering when the file is empty, read from package.json.
 *
 * Only scripts that name a port: a script whose port we cannot work out is one
 * the panel could start and then have nothing to open, which is worse than not
 * offering it.
 */
export function suggestFromPackage(pkgJson: string): ServerConfig[] {
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(pkgJson) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const out: ServerConfig[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== "string") continue;
    if (!/\b(dev|start|serve|preview)\b/.test(name)) continue;
    const port = portOf(cmd);
    if (!port) continue;
    out.push({
      id: `pkg-${name}`,
      name,
      command: `npm run ${name}`,
      port,
    });
  }
  return out;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The port a server says it actually took.
 *
 * Declaring 5173 does not get you 5173. Vite finds it busy, moves to 5174 and
 * announces the new one — so waiting on the declared port reports a failure
 * for a server that is running, and the panel then offers a stop button for a
 * port with nothing on it.
 *
 * URLs are preferred over prose because the prose is a trap: "Port 5173 is in
 * use, trying another one" names the port that did NOT work.
 */
export function portFromOutput(raw: string): number | null {
  const text = raw.replace(ANSI, "");
  const urls = [
    ...text.matchAll(
      /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/gi,
    ),
  ];
  const last = urls[urls.length - 1]?.[1];
  if (last) return Number(last);
  // No URL: accept "listening on port N", but only with a word that means it
  // succeeded in front of it.
  const phrase = [
    ...text.matchAll(
      /(?:listening|running|ready|started|available|serving)[^\n]{0,40}?\bport\s+(\d{2,5})/gi,
    ),
  ];
  const p = phrase[phrase.length - 1]?.[1];
  return p ? Number(p) : null;
}

/** The port a command pins, if it pins one. */
export function portOf(command: string): number | null {
  const m = /(?:--port[= ]|-p[= ]|PORT=)(\d{2,5})/.exec(command);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port >= 80 && port <= 65535 ? port : null;
}

// ─── Supervisor ───────────────────────────────────────────────────────────

interface Running {
  child: ChildProcess;
  startedAt: number;
  status: ServerStatus;
  error?: string;
  /** Tail of the output, so a failure can say what it said. */
  output: string[];
  /** Where it actually landed, once it says so. */
  actualPort?: number;
}

const running = new Map<string, Running>();
let onChange: (() => void) | null = null;

export function watchServers(cb: () => void): void {
  onChange = cb;
}

const notify = (): void => onChange?.();

function portOpenOn(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
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

/**
 * True when something local is listening on the port — on EITHER loopback.
 *
 * Vite on Windows binds ::1, not 127.0.0.1 (Node 17+ resolves localhost to
 * IPv6 first). The browser reaches it, because the OS resolves localhost the
 * same way — so probing only 127.0.0.1 reported "starting…" forever for a
 * server that was already serving the page on screen.
 */
async function portOpen(port: number, timeoutMs = 250): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    portOpenOn("127.0.0.1", port, timeoutMs),
    portOpenOn("::1", port, timeoutMs),
  ]);
  return v4 || v6;
}

/**
 * Everything the panel needs to draw the list.
 *
 * "Running" is the PORT answering, not the process being alive. A dev server
 * takes a few seconds to bind, and one that crashed on a syntax error leaves a
 * perfectly healthy npm shell behind it — so a process check alone reports a
 * server that is not there, which is exactly the lie that sends someone
 * reloading a blank page.
 */
export async function serverStates(workspace: string): Promise<ServerState[]> {
  const configs = readServers(workspace);
  return Promise.all(
    configs.map(async (c) => {
      const live = running.get(c.id);
      // Check where it actually is, not where it was asked to be.
      const port = live?.actualPort ?? c.port;
      const answering = await portOpen(port);
      if (!live) {
        return {
          ...c,
          declared: true,
          status: answering ? ("running" as const) : ("stopped" as const),
          externallyRunning: answering,
        };
      }
      return {
        ...c,
        declared: true,
        status: answering ? ("running" as const) : live.status,
        error: live.error,
        startedAt: live.startedAt,
        ...(live.actualPort && live.actualPort !== c.port
          ? { actualPort: live.actualPort }
          : {}),
      };
    }),
  );
}

/** Find one by id, or by the name a person (or a model) would use. */
export function findServer(workspace: string, key: string): ServerConfig | null {
  const list = readServers(workspace);
  const k = key.trim().toLowerCase();
  return (
    list.find((s) => s.id.toLowerCase() === k) ??
    list.find((s) => s.name.toLowerCase() === k) ??
    null
  );
}

/**
 * Start it and wait until the port actually answers.
 *
 * The awaitable version exists for the agent. Without it the model starts a
 * server, immediately navigates to a port nothing is listening on yet, gets a
 * connection refused, and concludes the site is broken — which is why a model
 * with only a shell ends up writing `sleep 5` and hoping.
 */
export async function startAndWait(
  workspace: string,
  id: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; error?: string; port?: number; alreadyUp?: boolean }> {
  const config = readServers(workspace).find((s) => s.id === id);
  if (!config) return { ok: false, error: `No server ${id}` };
  // Already answering: that is the state anyone wanted, whoever produced it.
  // Refusing here told the model a running server was a failure.
  if (await portOpen(config.port))
    return { ok: true, port: config.port, alreadyUp: true };

  startServer(workspace, id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const live = running.get(id);
    // The port it announced beats the port it was asked for.
    const said = live ? portFromOutput(live.output.join("")) : null;
    const port = said ?? config.port;
    if (await portOpen(port)) {
      if (live && said && said !== config.port) live.actualPort = said;
      notify();
      return { ok: true, port };
    }
    if (live?.status === "failed")
      return { ok: false, error: live.error ?? "it exited" };
    if (!live) return { ok: false, error: "the process exited" };
  }
  return { ok: false, error: `nothing came up on :${config.port} in time` };
}

export function startServer(workspace: string, id: string): void {
  if (running.has(id)) return;
  const config = readServers(workspace).find((s) => s.id === id);
  if (!config) return;

  const isWin = process.platform === "win32";
  // Through a shell, because the command is what a person would type. Which is
  // also why stopping needs the whole tree — see stopServer.
  const child = isWin
    ? spawn("cmd.exe", ["/d", "/s", "/c", config.command], {
        cwd: config.cwd ? join(workspace, config.cwd) : workspace,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn("sh", ["-c", config.command], {
        cwd: config.cwd ? join(workspace, config.cwd) : workspace,
      });

  const state: Running = {
    child,
    startedAt: Date.now(),
    status: "starting",
    output: [],
  };
  running.set(id, state);
  notify();

  const collect = (buf: Buffer): void => {
    state.output.push(buf.toString("utf-8"));
    // Enough to explain a failure, not enough to hold a build log in memory.
    if (state.output.length > 80) state.output.splice(0, state.output.length - 80);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  child.once("error", (err) => {
    state.status = "failed";
    state.error = err.message;
    notify();
  });

  child.once("exit", (code) => {
    // An exit while starting is a failure worth reporting; an exit after the
    // port came up is usually the user stopping it.
    if (state.status === "starting" && code !== 0) {
      state.status = "failed";
      state.error =
        state.output.join("").trim().split("\n").slice(-3).join("\n") ||
        `exited with code ${code}`;
      // Keep the record so the panel can show why, but let a retry replace it.
      setTimeout(() => {
        if (running.get(id) === state) running.delete(id);
        notify();
      }, 30_000);
    } else {
      running.delete(id);
    }
    notify();
  });

  // Give up waiting after a while: a server that has not bound in 90 seconds
  // is not starting, it is stuck, and "starting…" forever tells nobody that.
  const deadline = Date.now() + 90_000;
  const poll = async (): Promise<void> => {
    const live = running.get(id);
    if (live !== state || state.status !== "starting") return;
    // The port it announced beats the port it was asked for — Vite moves to
    // the next free one and says so. This poll serves the panel's Play button;
    // startAndWait (the tool's path) does the same dance itself.
    const said = portFromOutput(state.output.join(""));
    if (said && said !== config.port) state.actualPort = said;
    if (await portOpen(said ?? config.port)) {
      state.status = "running";
      notify();
      return;
    }
    if (Date.now() > deadline) {
      state.status = "failed";
      state.error = `Nothing came up on :${config.port} within 90s.`;
      notify();
      return;
    }
    setTimeout(() => void poll(), 500);
  };
  setTimeout(() => void poll(), 500);
}

/**
 * Stop it, and everything it started.
 *
 * `npm run dev` is a shell that spawns node that spawns the bundler. Killing
 * the child we hold kills the shell and leaves the bundler holding the port —
 * so the panel says stopped, the page still loads, and the next start dies on
 * EADDRINUSE. tree-kill walks the actual process tree.
 *
 * Fire-and-forget, for the quit path. Anything user-facing goes through
 * stopServerAndWait, which can also stop a server this app never started and
 * refuses to claim success while the port still answers.
 */
export function stopServer(id: string): void {
  const live = running.get(id);
  if (!live?.child.pid) {
    running.delete(id);
    notify();
    return;
  }
  treeKill(live.child.pid, "SIGTERM", () => {
    running.delete(id);
    notify();
  });
}

/** App quit: nothing we started outlives us. */
export function stopAllServers(): void {
  for (const id of [...running.keys()]) stopServer(id);
}

/** One short-lived command, its stdout collected. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf-8")));
    child.once("error", () => resolve(""));
    child.once("close", () => resolve(out));
  });
}

/**
 * The listener PIDs in a `netstat -ano` dump, for one port.
 *
 * Filtered by a FOREIGN address of `:0` — that is what a listening socket
 * shows, and unlike the "LISTENING" state column it is not localised (a
 * German Windows prints ABHÖREN there). TIME_WAIT ghosts carry pid 0 and a
 * real foreign port, so both filters exclude them; pid 4 is the kernel's
 * System process, which a bug here must never nominate for killing.
 */
export function listenerPidsFromNetstat(out: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "TCP") continue;
    if (!parts[1]?.endsWith(`:${port}`)) continue;
    if (!parts[2]?.endsWith(":0")) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 4) pids.add(pid);
  }
  return [...pids];
}

/**
 * The processes LISTENING on a local port.
 *
 * Windows: netstat without a `-p` filter — `-p TCP` would hide the IPv6
 * listener, and Vite on Windows IS the IPv6 listener. POSIX: lsof.
 */
async function pidsOnPort(port: number): Promise<number[]> {
  const pids = new Set<number>();
  if (process.platform === "win32") {
    for (const pid of listenerPidsFromNetstat(await run("netstat", ["-ano"]), port))
      pids.add(pid);
  } else {
    const out = await run("lsof", [`-nP`, `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    }
  }
  // Never the app itself: the main process listens on ports of its own (the
  // dev API), and "stop the server" must not be able to mean "quit".
  pids.delete(process.pid);
  return [...pids];
}

function killPid(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32")
    // /T for the tree: the listener is usually node under an npm shell, and
    // the shell would otherwise restart nothing but keep the console handle.
    return run("taskkill", ["/T", "/F", "/PID", String(pid)]).then(() => {});
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    /* already gone */
  }
  return Promise.resolve();
}

async function portClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await portOpen(port));
}

/**
 * Stop whatever serves the port, and only then say so.
 *
 * The old path had a hole a user fell straight into: stop a server that this
 * app did not start (a terminal, a previous app run, the agent's shell) and
 * there is no child to kill — the map entry vanished, the tool said
 * "stopped", and the page kept loading. Found in use, reported with a
 * screenshot of the lie.
 *
 * So: kill our own tree when we have one, then measure the port, and if it
 * still answers, find the actual listener and kill that. Success is defined
 * by the port going silent — never by our bookkeeping.
 */
export async function stopServerAndWait(
  port: number,
  id?: string,
): Promise<{ ok: boolean; error?: string; external?: boolean }> {
  const live = id ? running.get(id) : undefined;
  // Where it actually listens beats where it was declared.
  const target = live?.actualPort ?? port;

  if (live?.child.pid) {
    await new Promise<void>((resolve) =>
      treeKill(live.child.pid!, "SIGTERM", () => resolve()),
    );
    if (id) running.delete(id);
    notify();
    if (await portClosed(target, 4_000)) return { ok: true };
  } else if (!(await portOpen(target))) {
    // Nothing to do — but that is a fact worth stating over a fake success.
    if (id) running.delete(id);
    notify();
    return { ok: true };
  }

  // Ours is gone (or never existed) and the port still answers: somebody
  // else's process. Find it and stop it too.
  const pids = await pidsOnPort(target);
  if (pids.length === 0)
    return {
      ok: false,
      error: `:${target} still answers but no local listener was found — it may be a proxy or a container port mapping.`,
    };
  for (const pid of pids) await killPid(pid, false);
  if (await portClosed(target, 4_000)) return { ok: true, external: true };
  // A TERM that was ignored gets a KILL, once.
  for (const pid of await pidsOnPort(target)) await killPid(pid, true);
  if (await portClosed(target, 3_000)) return { ok: true, external: true };
  return {
    ok: false,
    error: `:${target} is still answering after killing pid(s) ${pids.join(", ")}.`,
  };
}

/** The tail of a server's output, for the panel's failure message. */
export function serverOutput(id: string): string {
  return (running.get(id)?.output ?? []).join("").slice(-4000);
}

export function serversConfigPath(workspace: string): string {
  return configPath(workspace);
}

/**
 * Everything listening, declared or not.
 *
 * The list used to show only what the project file declared, which meant a
 * server the AGENT started did not appear at all — it ran `npm run dev` through
 * a shell, which knows nothing about .monet/servers.json. The same was true of
 * one you started in a terminal. A list of dev servers that omits the running
 * ones is answering a question nobody asked.
 *
 * Matched by port, because that is the only thing the two sides share: a
 * declared entry whose port is answering IS that server, however it was
 * started.
 */
export function mergeDetected(
  declared: ServerState[],
  detected: { port: number; url: string; title: string }[],
): ServerState[] {
  const claimed = new Set(declared.map((d) => d.port));
  const found: ServerState[] = detected
    .filter((d) => !claimed.has(d.port))
    .map((d) => ({
      id: `found-${d.port}`,
      name: d.title || `:${d.port}`,
      // Nothing to put here: we did not start it and cannot know how. The UI
      // reads this as "no start button", which is the truth.
      command: "",
      port: d.port,
      declared: false,
      status: "running" as const,
      externallyRunning: true,
    }));
  return [...declared, ...found];
}

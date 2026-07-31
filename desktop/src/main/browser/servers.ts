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
}

// ─── Config file ──────────────────────────────────────────────────────────

function configPath(workspace: string): string {
  return join(workspace, ".monet", "servers.json");
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
}

const running = new Map<string, Running>();
let onChange: (() => void) | null = null;

export function watchServers(cb: () => void): void {
  onChange = cb;
}

const notify = (): void => onChange?.();

function portOpen(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
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
      const answering = await portOpen(c.port);
      if (!live) {
        return {
          ...c,
          status: answering ? ("running" as const) : ("stopped" as const),
          externallyRunning: answering,
        };
      }
      return {
        ...c,
        status: answering ? ("running" as const) : live.status,
        error: live.error,
        startedAt: live.startedAt,
      };
    }),
  );
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
    if (await portOpen(config.port)) {
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

/** The tail of a server's output, for the panel's failure message. */
export function serverOutput(id: string): string {
  return (running.get(id)?.output ?? []).join("").slice(-4000);
}

export function serversConfigPath(workspace: string): string {
  return configPath(workspace);
}

/**
 * Terminal sessions — one live shell per chat, in a pty.
 *
 * What was here before ran ONE command per container and waited for it to
 * exit. Everything a terminal is for fell out of that: `cd` was forgotten by
 * the next line, `npm run dev` showed nothing for five minutes and was then
 * killed by the timeout, Ctrl+C printed "^C" without killing anything, and the
 * output was monochrome because a container started without -t makes every
 * program turn its colours off.
 *
 * So the shell is a process that STAYS. It lives in main, keyed by chat, and
 * the window attaches to it — which is also what makes a build survive
 * switching chats: nothing about it is in the renderer except the picture.
 *
 * The pty is the part that matters. It is what gives programs a terminal to
 * detect, and with it come colours, Ctrl+C, progress bars that rewrite their
 * line, and full-screen programs that need to know the window size.
 */

import { spawn as ptySpawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { getSessionEngine } from "../sandbox/config.js";
import {
  PIP_ENV_ARGS,
  PIP_VOLUME_ARGS,
  activeImageTag,
  ensureSandboxImage,
  sandboxWorkDir,
} from "../sandbox/podman-engine.js";
import { getProjectRoot } from "../engine/state/state.js";
import { addPodmanToPath, podmanBinDir } from "../sandbox/podman-binary.js";
import { existsSync } from "fs";
import { join } from "path";

/**
 * How much output to keep per chat, for redrawing the screen on reattach.
 *
 * A terminal is a picture of what happened, and the renderer's copy of it dies
 * with the panel. 256 KB is a few thousand lines — enough that coming back to
 * a build shows its history, and small enough that ten chats left open cost
 * megabytes rather than the whole log of a webpack watch.
 */
const BUFFER_LIMIT = 256 * 1024;

export interface TerminalSession {
  sessionId: string;
  pty: IPty;
  /** Everything written out, trimmed to BUFFER_LIMIT from the front. */
  buffer: string;
  cols: number;
  rows: number;
  /** Set once the process exits — the row stays so the last words survive. */
  exited?: { code: number; signal?: number };
}

const sessions = new Map<string, TerminalSession>();

type Listener = (sessionId: string, data: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to output from every session — the IPC layer forwards to windows. */
export function onTerminalData(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type ExitListener = (sessionId: string, code: number) => void;
const exitListeners = new Set<ExitListener>();

export function onTerminalExit(fn: ExitListener): () => void {
  exitListeners.add(fn);
  return () => exitListeners.delete(fn);
}

/**
 * The podman executable, by ABSOLUTE path.
 *
 * child_process.spawn("podman") works because it searches PATH. conpty does
 * not: it hands the name to CreateProcess, whose search list is the app
 * directory, the system directories and PATH — and the portable CLI lives in
 * the app's data dir, which is on none of them until addPodmanToPath() has
 * run. The failure is silent about its cause, because node-pty's own message
 * is the literal string "File not found: " with the name left off, which is
 * exactly what the user saw.
 *
 * So: patch PATH (podman's own helpers want it too), then hand over a full
 * path rather than trusting the search.
 */
export function podmanExecutable(): string | null {
  addPodmanToPath();
  const dir = podmanBinDir();
  const exe = process.platform === "win32" ? "podman.exe" : "podman";
  if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  // A system-wide install: no directory of ours, but PATH may still have it.
  // CreateProcess does search PATH, so this is worth trying before failing.
  return null;
}

function hostShell(): { file: string; args: string[] } {
  if (process.platform === "win32")
    // -NoLogo: the copyright banner is three lines of nothing every time.
    return { file: "powershell.exe", args: ["-NoLogo"] };
  const sh = process.env.SHELL || "/bin/bash";
  // Login shell, so the user's own PATH and aliases are there — the point of
  // a terminal in Code is that it behaves like their terminal.
  return { file: sh, args: ["-l"] };
}

/**
 * The command that opens a shell INSIDE this chat's sandbox.
 *
 * `-it` is the whole difference from the old one-shot runner: a TTY inside the
 * container, which is what makes programs there emit colour and lets Ctrl+C
 * reach them. Everything else matches what RunCommand mounts, so the terminal
 * and the agent see one filesystem and one set of installed packages.
 */
export function sandboxShellArgs(sessionId: string): string[] {
  return [
    "run",
    "-it",
    "--rm",
    "-v",
    `${sandboxWorkDir(sessionId)}:/work`,
    ...PIP_VOLUME_ARGS,
    ...PIP_ENV_ARGS,
    "-w",
    "/work",
    activeImageTag(),
    "bash",
    "-l",
  ];
}

/** Is there a terminal for this chat right now? */
export function hasTerminal(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** The screen so far, for a panel that just mounted. */
export function terminalBuffer(sessionId: string): string {
  return sessions.get(sessionId)?.buffer ?? "";
}

export async function openTerminal(
  sessionId: string,
  space: string | undefined,
  cols = 80,
  rows = 24,
): Promise<{ ok: boolean; buffer?: string; error?: string }> {
  const existing = sessions.get(sessionId);
  if (existing) {
    // Reattaching: the panel was closed and reopened, or the chat came back.
    // Resize to whatever the new panel is, and hand back the screen.
    if (cols !== existing.cols || rows !== existing.rows) {
      try {
        existing.pty.resize(cols, rows);
        existing.cols = cols;
        existing.rows = rows;
      } catch {
        /* a dead pty refuses to resize; the exit notice already went out */
      }
    }
    return { ok: true, buffer: existing.buffer };
  }

  let file: string;
  let args: string[];
  let cwd: string;
  const engine = space === "home" ? getSessionEngine(sessionId) : null;
  if (space === "home" && engine === "docker") {
    // The image has to exist before a container can start from it, and this is
    // also what settles which tag — the base, or the user's added toolchains.
    const image = await ensureSandboxImage();
    if (!image.ok)
      return { ok: false, error: image.error ?? "The sandbox image is not ready." };
    // Absolute where we can find it — see podmanExecutable for why a bare
    // name is not enough here, even though it is everywhere else.
    file = podmanExecutable() ?? "podman";
    args = sandboxShellArgs(sessionId);
    cwd = sandboxWorkDir(sessionId);
  } else if (space === "home" && engine === "subprocess") {
    // The weak-isolation engine IS the host, scoped to the chat's folder — so
    // its terminal is the host's shell opened there. The same bargain the user
    // accepted when they picked that engine, and the same folder RunPython
    // writes into.
    const shell = hostShell();
    file = shell.file;
    args = shell.args;
    cwd = sandboxWorkDir(sessionId);
  } else if (space === "home") {
    return {
      ok: false,
      error:
        "The Pyodide sandbox has no shell (it runs in WebAssembly). Switch the engine to Podman or Subprocess in Settings → Sandbox.",
    };
  } else {
    const shell = hostShell();
    file = shell.file;
    args = shell.args;
    cwd = getProjectRoot();
  }

  let pty: IPty;
  try {
    pty = ptySpawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        // Programs read these to decide whether to colour. The pty already
        // makes isatty() true; these settle the ones that ask twice.
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
      } as Record<string, string>,
    });
  } catch (err) {
    // node-pty's "File not found: " arrives with the name left off, so the
    // one fact worth having is missing from it. Put it back.
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: /file not found/i.test(why)
        ? `Could not start a shell: ${file} was not found.`
        : `Could not start a shell: ${why}`,
    };
  }

  const session: TerminalSession = { sessionId, pty, buffer: "", cols, rows };
  sessions.set(sessionId, session);

  pty.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > BUFFER_LIMIT)
      session.buffer = session.buffer.slice(-BUFFER_LIMIT);
    for (const fn of listeners) fn(sessionId, data);
  });

  pty.onExit(({ exitCode, signal }) => {
    session.exited = { code: exitCode, signal };
    // The row is dropped, but the words are not: a shell that died on a typo
    // in .bashrc has to leave its reason on screen, so the notice goes out
    // before the session disappears.
    const note = `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`;
    session.buffer += note;
    for (const fn of listeners) fn(sessionId, note);
    sessions.delete(sessionId);
    for (const fn of exitListeners) fn(sessionId, exitCode);
  });

  return { ok: true, buffer: "" };
}

export function writeTerminal(sessionId: string, data: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  try {
    s.pty.write(data);
    return true;
  } catch {
    return false;
  }
}

export function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): boolean {
  const s = sessions.get(sessionId);
  if (!s || cols < 1 || rows < 1) return false;
  try {
    s.pty.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
    return true;
  } catch {
    return false;
  }
}

/**
 * End the session.
 *
 * NOT called when the panel closes — that is the point of the whole file. This
 * is for the chat being deleted, the app quitting, or the user explicitly
 * killing the shell.
 */
export function closeTerminal(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
}

/** Every live session — for app shutdown. */
export function closeAllTerminals(): void {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}

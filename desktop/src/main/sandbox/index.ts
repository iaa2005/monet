/**
 * Sandbox dispatcher — the single entry point every caller uses.
 *
 * Picks the configured engine (Pyodide default, subprocess opt-in, Docker
 * reserved → falls back to Pyodide), runs the code, and persists any files the
 * code produced into the session's artifacts folder so they show up in the UI
 * and can be opened.
 */

import { extname } from "path";
import { getSessionEngine } from "./config.js";
import { runPyodide } from "./pyodide-engine.js";
import { runSubprocess, runSubprocessCommand } from "./subprocess-engine.js";
import { runPodman, runPodmanCommand } from "./podman-engine.js";
import { saveArtifactBuffer } from "../ipc/artifacts.js";
import type { SandboxRunResult } from "./types.js";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".tex": "text/x-tex",
};

export function mediaTypeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export async function runInSandbox(
  sessionId: string,
  code: string,
): Promise<SandboxRunResult> {
  const engine = getSessionEngine(sessionId);
  const raw =
    engine === "subprocess"
      ? await runSubprocess(sessionId, "python", code)
      : engine === "docker"
        ? await runPodman(sessionId, code)
        : await runPyodide(sessionId, code); // pyodide default

  const files = raw.files.map((f) => ({
    name: f.name,
    path: saveArtifactBuffer(sessionId, f.name, f.bytes),
    mediaType: mediaTypeOf(f.name),
  }));

  const engineName =
    engine === "subprocess"
      ? "subprocess"
      : engine === "docker"
        ? "podman"
        : "pyodide";

  return {
    ok: raw.ok,
    engine: engineName,
    stdout: raw.stdout,
    stderr: raw.stderr,
    files,
    error: raw.error,
  };
}

/**
 * Run a raw shell command in the Podman sandbox (RunCommand tool), persisting
 * any files it wrote — mirrors runInSandbox so RunCommand surfaces artifacts
 * exactly like RunPython. Podman-only; the tool guards the engine.
 */
export async function runCommandInSandbox(
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  const raw = await runPodmanCommand(sessionId, command, signal);
  const files = raw.files.map((f) => ({
    name: f.name,
    path: saveArtifactBuffer(sessionId, f.name, f.bytes),
    mediaType: mediaTypeOf(f.name),
  }));
  return {
    ok: raw.ok,
    engine: "podman",
    stdout: raw.stdout,
    stderr: raw.stderr,
    files,
    error: raw.error,
  };
}

/** Whether the chat's engine has a real shell (Home terminal). Pyodide is
 * WebAssembly with no process model, so it has none. */
export function sandboxSupportsShell(sessionId: string): boolean {
  return getSessionEngine(sessionId) !== "pyodide";
}

/**
 * Run an interactive-terminal command in the chat's sandbox (the Home shell).
 *
 * Podman  → a fresh container over the chat's /work mount (isolated).
 * Subprocess → a host shell scoped to the chat's folder (weak isolation).
 * Pyodide → no shell; returns an error telling the user to switch engines.
 *
 * Each command runs independently — shell state (cwd, env, background jobs)
 * does NOT persist between commands; only files written into the folder do
 * (they show up in Home's Files panel). We don't copy them into Artifacts here,
 * to avoid flooding it on every `ls`/build; the sandbox folder is the source of
 * truth the Files panel already reads.
 */
export async function runShellInSandbox(
  sessionId: string,
  command: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const engine = getSessionEngine(sessionId);
  if (engine === "docker") {
    const r = await runPodmanCommand(sessionId, command);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error };
  }
  if (engine === "subprocess") {
    const r = await runSubprocessCommand(sessionId, command);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error };
  }
  return {
    ok: false,
    stdout: "",
    stderr: "",
    error:
      "The Pyodide sandbox has no shell (it runs in WebAssembly). Switch the engine to Podman or Subprocess in Settings → Sandbox to use a terminal.",
  };
}

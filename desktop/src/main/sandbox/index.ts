/**
 * Sandbox dispatcher — the single entry point every caller uses.
 *
 * Picks the configured engine (Pyodide default, subprocess opt-in, Docker
 * reserved → falls back to Pyodide), runs the code, and persists any files the
 * code produced into the session's artifacts folder so they show up in the UI
 * and can be opened.
 */

import { extname } from "path";
import { getSandboxConfig } from "./config.js";
import { runPyodide } from "./pyodide-engine.js";
import { runSubprocess } from "./subprocess-engine.js";
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
  const engine = getSandboxConfig().engine;
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
): Promise<SandboxRunResult> {
  const raw = await runPodmanCommand(sessionId, command);
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

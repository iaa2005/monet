/**
 * Pyodide engine PROXY — the actual Python runs in a worker_thread
 * (pyodide.worker.ts), so heavy computations never freeze the app.
 *
 * The worker owns the Pyodide instance and the per-chat in-memory FS
 * (/sessions/<id>, persisted between runs and re-seeded from the chat's
 * on-disk artifacts after a restart). This proxy manages the worker
 * lifecycle, one pending promise per run, and a hard timeout that restarts
 * the worker if Python wedges (files survive on disk via the artifacts).
 */

import { Worker } from "worker_threads";
import { join } from "path";
import { getDataDir } from "../data-dir.js";
import { sandboxWorkDir } from "./podman-engine.js";
import type { EngineResult, SandboxFile } from "./types.js";

const RUN_TIMEOUT_MS = 240_000;

interface WorkerResult {
  type: "result";
  id: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  files: { name: string; bytes: ArrayBuffer }[];
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: EngineResult) => void>();

function sessionDirFor(sessionId: string): string {
  return "/sessions/" + (sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "session");
}

function failAllPending(error: string): void {
  for (const [, resolve] of pending)
    resolve({ ok: false, stdout: "", stderr: "", files: [], error });
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./pyodide-worker.js", import.meta.url));
  worker.on("message", (msg: WorkerResult) => {
    if (msg.type !== "result") return;
    const resolve = pending.get(msg.id);
    if (!resolve) return; // timed out earlier
    pending.delete(msg.id);
    const files: SandboxFile[] = msg.files.map((f) => ({
      name: f.name,
      bytes: new Uint8Array(f.bytes),
    }));
    resolve({
      ok: msg.ok,
      stdout: msg.stdout,
      stderr: msg.stderr,
      files,
      error: msg.error,
    });
  });
  worker.on("error", (err) => {
    failAllPending(`Sandbox worker crashed: ${err.message}`);
    worker = null;
  });
  worker.on("exit", () => {
    failAllPending("Sandbox worker exited unexpectedly.");
    worker = null;
  });
  return worker;
}

export async function runPyodide(
  sessionId: string,
  code: string,
): Promise<EngineResult> {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // A wedged interpreter can't be interrupted — replace the worker.
      // Session files live on disk (artifacts) and re-seed on the next run.
      try {
        void worker?.terminate();
      } catch {
        /* already gone */
      }
      worker = null;
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        files: [],
        error: `Python run timed out after ${RUN_TIMEOUT_MS / 1000}s — the sandbox was restarted (saved files are preserved).`,
      });
    }, RUN_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    w.postMessage({
      type: "run",
      id,
      code,
      memDir: sessionDirFor(sessionId),
      // Real per-chat working tree (subfolders preserved) — seeded in and
      // written back out recursively.
      workDir: sandboxWorkDir(sessionId),
      cacheDir: join(getDataDir(), "pyodide-cache"),
    });
  });
}

/** Wipe a session's in-memory files in the LIVE worker (incognito purge).
 * No-op when the worker is cold — there is nothing in memory then. */
export function wipePyodideSession(sessionId: string): void {
  if (!worker) return;
  worker.postMessage({ type: "wipe", memDir: sessionDirFor(sessionId) });
}

/** Push a file into the LIVE worker's session dir (no-op when the worker is
 * cold — the seeder picks the file up from disk on the next run). */
export function mirrorToPyodideSession(
  sessionId: string,
  name: string,
  bytes: Uint8Array,
): void {
  if (!worker) return;
  const copy = bytes.slice();
  worker.postMessage(
    {
      type: "mirror",
      memDir: sessionDirFor(sessionId),
      name,
      bytes: copy.buffer,
    },
    [copy.buffer],
  );
}

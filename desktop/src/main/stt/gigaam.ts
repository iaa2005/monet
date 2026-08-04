/**
 * Installing and running the on-device GigaAM models.
 *
 * Downloads land in `<dataDir>/stt-models/<id>/`, one directory per model, and
 * every file is written to `<name>.part` first: a download killed halfway
 * used to leave a truncated .onnx that looked installed and failed at load
 * with an ONNX parse error nobody could act on. A `.part` left behind is
 * plainly unfinished, and the next install overwrites it.
 *
 * Every file is also checked against the sha256 HuggingFace publishes: the
 * first version of this downloader wrote a file of exactly the right size
 * with the wrong bytes, and a corrupt ONNX does not fail politely.
 *
 * The recognizer itself lives in a separate process (gigaam.child.ts) — see
 * the note there about why it cannot sit in main, or even in main's threads.
 *
 * The native module is OPTIONAL at runtime: a platform sherpa-onnx has no
 * prebuilt binary for must still get a working app with the other two
 * engines, so nothing here imports it at the top level.
 */

import { fork, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { createWriteStream } from "fs";
import { mkdir, readdir, rm, rename, stat } from "fs/promises";
import { join } from "path";
import { cpus } from "os";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { getDataDir } from "../data-dir.js";
import {
  STT_MODELS,
  downloadProblem,
  fileName,
  fileUrl,
  modelBytes,
  sttModel,
  type SttModelInfo,
} from "./catalog.js";

const require = createRequire(import.meta.url);

export interface SttModelStatus {
  id: string;
  label: string;
  note: string;
  languages: string;
  punctuation: boolean;
  bytes: number;
  installed: boolean;
  /** Bytes present on disk — a part-installed model reports what it has. */
  onDisk: number;
  installing: boolean;
}

export interface InstallProgress {
  id: string;
  loaded: number;
  total: number;
  /** 0–100, over the whole model rather than the current file. */
  percent: number;
  done?: boolean;
  error?: string;
}

/** Is the native runtime present at all on this platform? */
export function sttNativeAvailable(): boolean {
  try {
    require.resolve("sherpa-onnx-node");
    return true;
  } catch {
    return false;
  }
}

export function modelsDir(): string {
  return join(getDataDir(), "stt-models");
}

function dirFor(id: string): string {
  return join(modelsDir(), id);
}

/** Absolute paths by role, or null when a file is missing. */
export async function modelFiles(
  m: SttModelInfo,
): Promise<Record<string, string> | null> {
  const dir = dirFor(m.id);
  const out: Record<string, string> = {};
  for (const f of m.files) {
    const path = join(dir, fileName(f));
    try {
      const s = await stat(path);
      if (!s.isFile() || s.size === 0) return null;
    } catch {
      return null;
    }
    out[f.role] = path;
  }
  return out;
}

async function bytesOnDisk(m: SttModelInfo): Promise<number> {
  const dir = dirFor(m.id);
  let total = 0;
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".part")) continue;
      try {
        total += (await stat(join(dir, name))).size;
      } catch {
        /* vanished mid-scan */
      }
    }
  } catch {
    return 0;
  }
  return total;
}

const installing = new Map<string, AbortController>();

export async function listSttModels(): Promise<SttModelStatus[]> {
  const out: SttModelStatus[] = [];
  for (const m of STT_MODELS) {
    out.push({
      id: m.id,
      label: m.label,
      note: m.note,
      languages: m.languages,
      punctuation: m.punctuation,
      bytes: modelBytes(m),
      installed: (await modelFiles(m)) !== null,
      onDisk: await bytesOnDisk(m),
      installing: installing.has(m.id),
    });
  }
  return out;
}

/**
 * Fetch every file of a model, reporting ONE percentage across all of them —
 * per-file percentages jump backwards and read as a stuck download.
 */
export async function installModel(
  id: string,
  onProgress: (p: InstallProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const m = sttModel(id);
  if (!m) return { ok: false, error: `Unknown model ${id}` };
  if (installing.has(id)) return { ok: false, error: "Already downloading" };

  const controller = new AbortController();
  installing.set(id, controller);
  const dir = dirFor(id);
  const total = modelBytes(m);
  let loaded = 0;
  let lastPercent = -1;

  try {
    await mkdir(dir, { recursive: true });
    for (const f of m.files) {
      const target = join(dir, fileName(f));
      const part = `${target}.part`;
      const res = await fetch(fileUrl(m, f), { signal: controller.signal });
      if (!res.ok || !res.body) {
        throw new Error(`${fileName(f)}: HTTP ${res.status}`);
      }
      // Progress is counted INSIDE the pipeline. Counting it from a `data`
      // listener on the source put the stream in flowing mode alongside the
      // pipe, and what landed on disk was the right length with the wrong
      // bytes — a 225 MB ONNX that killed the recognizer with no message.
      const hash = createHash("sha256");
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          loaded += chunk.length;
          hash.update(chunk);
          const percent = Math.min(99, Math.floor((loaded / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress({ id, loaded, total, percent });
          }
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as never),
        count,
        createWriteStream(part),
      );
      const problem = downloadProblem(
        f,
        hash.digest("hex"),
        (await stat(part)).size,
      );
      if (problem) throw new Error(problem);
      await rename(part, target);
    }
    onProgress({ id, loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const error = aborted
      ? "Download cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
    // A cancelled or failed download leaves nothing that looks installed.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    onProgress({ id, loaded, total, percent: 0, done: true, error });
    return { ok: false, error };
  } finally {
    installing.delete(id);
  }
}

export function cancelInstall(id: string): boolean {
  const c = installing.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

export async function removeModel(id: string): Promise<{ ok: boolean }> {
  cancelInstall(id);
  // The recognizer may still hold the files open; let it go before deleting.
  if (loadedModelId === id) disposeChild();
  await rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

// ── The recognizer process ──────────────────────────────────────────────

interface ChildReply {
  id: number;
  type: "result" | "error";
  text?: string;
  error?: string;
  loadMs?: number;
  decodeMs?: number;
}

let child: ChildProcess | null = null;
let seq = 0;
let loadedModelId = "";
const pending = new Map<number, (r: ChildReply) => void>();

function failAllPending(error: string): void {
  for (const [, resolve] of pending) resolve({ id: 0, type: "error", error });
  pending.clear();
}

function getChild(): ChildProcess {
  if (child && child.connected) return child;
  const script = fileURLToPath(new URL("./gigaam-child.js", import.meta.url));
  child = fork(script, [], {
    // In a packaged app `process.execPath` IS the app: this makes it behave
    // as a plain Node process rather than launching a second window.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    // Its stdout is the model's, not the app's — keep it out of the log.
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.on("message", (msg: ChildReply) => {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg);
  });
  // Keep the tail of its stderr: when the process dies at startup, THIS is
  // the only thing that says why, and "it exited" is not an error message.
  let stderrTail = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-800);
  });
  child.on("error", (err) => {
    failAllPending(`Speech process failed: ${err.message}`);
    child = null;
    loadedModelId = "";
  });
  child.on("exit", (code, signal) => {
    const why = stderrTail.trim().split(/\r?\n/).pop() ?? "";
    failAllPending(
      `Speech process exited (${signal ?? code})${why ? `: ${why}` : ""}`,
    );
    child = null;
    loadedModelId = "";
  });
  return child;
}

function disposeChild(): void {
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  child = null;
  loadedModelId = "";
}

/** Threads: half the cores, at least 2, at most 8 — dictation should not
 * fight the model run or the build the user has going. */
function threadCount(): number {
  return Math.max(2, Math.min(8, Math.floor(cpus().length / 2)));
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

export async function transcribePcm(
  modelId: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<{ ok: boolean; text?: string; error?: string; ms?: number }> {
  if (!sttNativeAvailable()) {
    return {
      ok: false,
      error: "On-device recognition is not available on this platform.",
    };
  }
  const m = sttModel(modelId);
  if (!m) return { ok: false, error: `Unknown model ${modelId}` };
  const files = await modelFiles(m);
  if (!files) {
    return { ok: false, error: `${m.label} is not downloaded yet.` };
  }

  const c = getChild();
  const id = ++seq;
  const t0 = Date.now();
  const reply = await new Promise<ChildReply>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // A wedged native call cannot be interrupted — replace the process.
      disposeChild();
      resolve({ id, type: "error", error: "Recognition timed out." });
    }, TRANSCRIBE_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    c.send({
      id,
      type: "transcribe",
      modelId,
      kind: m.kind,
      files,
      // A plain array: process IPC serialises as JSON, and a Float32Array
      // arrives on the other side as an object with numeric keys.
      samples: Array.from(samples),
      sampleRate,
      threads: threadCount(),
    });
  });

  if (reply.type === "error") return { ok: false, error: reply.error };
  loadedModelId = modelId;
  return { ok: true, text: reply.text ?? "", ms: Date.now() - t0 };
}

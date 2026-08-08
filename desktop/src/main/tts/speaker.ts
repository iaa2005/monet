/**
 * The voice matcher: one 29 MB model that turns a recording into "who".
 *
 * A speaker embedding is a vector describing the SPEAKER and (largely) not the
 * words — which is what makes it usable as a target: synthesise a candidate
 * voice, embed it, and compare with the embedding of the user's own recording.
 * Cosine similarity is the whole objective the voice fit optimises.
 *
 * CAM++ trained on VoxCeleb, large-margin finetuned: the small end of the
 * quality range (29 MB, tens of milliseconds per clip on CPU) and language-
 * agnostic in practice, which matters because the speaker here is Russian and
 * every published model of this kind is labelled "en".
 *
 * It runs through the sherpa-onnx that already ships for GigaAM — no new native
 * dependency, no extra runtime.
 *
 * NOTE: this is the one model the app does NOT fetch from huggingface.co/iaa2005
 * (see docs: every other model is mirrored there so a renamed upstream repo
 * cannot 404 an install). Mirroring it needs a write token, so for now it comes
 * from sherpa-onnx's own author's repository, which is where sherpa's examples
 * point too.
 */

import { fork, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { getDataDir } from "../data-dir.js";
import { fetchChecked } from "./engine.js";

const require = createRequire(import.meta.url);

const SPEAKER_REPO = "csukuangfj/speaker-embedding-models";
const SPEAKER_FILE = "wespeaker_en_voxceleb_CAM++_LM.onnx";
export const SPEAKER_BYTES = 29_292_687;
const SPEAKER_SHA256 = "e197af7e9d473030cf486b3124149a19bf37014d0e4485e4c70c483b0ec10cb2";

function speakerDir(): string {
  const d = join(getDataDir(), "tts-models", "speaker");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function speakerModelPath(): string {
  return join(speakerDir(), SPEAKER_FILE);
}

export async function speakerModelInstalled(): Promise<boolean> {
  try {
    const s = await stat(speakerModelPath());
    return s.isFile() && s.size === SPEAKER_BYTES;
  } catch {
    return false;
  }
}

export function speakerAvailable(): boolean {
  try {
    require.resolve("sherpa-onnx-node");
    return true;
  } catch {
    return false;
  }
}

let installing: AbortController | null = null;

export async function installSpeakerModel(
  onProgress: (p: { loaded: number; total: number; percent: number; done?: boolean; error?: string }) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (installing) return { ok: false, error: "Already downloading" };
  if (await speakerModelInstalled()) {
    onProgress({ loaded: SPEAKER_BYTES, total: SPEAKER_BYTES, percent: 100, done: true });
    return { ok: true };
  }
  installing = new AbortController();
  let loaded = 0;
  let last = -1;
  try {
    await fetchChecked({
      url: `https://huggingface.co/${SPEAKER_REPO}/resolve/main/${SPEAKER_FILE}`,
      target: speakerModelPath(),
      bytes: SPEAKER_BYTES,
      sha256: SPEAKER_SHA256,
      signal: installing.signal,
      onChunk: (n) => {
        loaded += n;
        const percent = Math.min(99, Math.floor((loaded / SPEAKER_BYTES) * 100));
        if (percent !== last) {
          last = percent;
          onProgress({ loaded, total: SPEAKER_BYTES, percent });
        }
      },
    });
    onProgress({ loaded: SPEAKER_BYTES, total: SPEAKER_BYTES, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = installing.signal.aborted
      ? "Download cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
    onProgress({ loaded, total: SPEAKER_BYTES, percent: 0, done: true, error });
    return { ok: false, error };
  } finally {
    installing = null;
  }
}

export function cancelSpeakerInstall(): boolean {
  if (!installing) return false;
  installing.abort();
  return true;
}

// ── The embedder process ────────────────────────────────────────────────

interface EmbedReply {
  id: number;
  type: "result" | "error";
  embedding?: number[];
  error?: string;
}

interface EmbedChild {
  proc: ChildProcess;
  pending: Map<number, (r: EmbedReply) => void>;
}

let live: EmbedChild | null = null;
let seq = 0;

function getChild(): EmbedChild {
  if (live && live.proc.connected) return live;
  const script = fileURLToPath(new URL("./embed-child.js", import.meta.url));
  const proc = fork(script, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const self: EmbedChild = { proc, pending: new Map() };
  let stderrTail = "";
  proc.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-800);
  });
  proc.on("message", (msg: EmbedReply) => {
    const resolve = self.pending.get(msg.id);
    if (!resolve) return;
    self.pending.delete(msg.id);
    resolve(msg);
  });
  // Only this child's own requests — the mistake that produced a stream of
  // "exited (SIGTERM)" errors in the synthesiser is not worth repeating here.
  const bury = (error: string): void => {
    for (const [, resolve] of self.pending) resolve({ id: 0, type: "error", error });
    self.pending.clear();
    if (live === self) live = null;
  };
  proc.on("error", (err) => bury(`Voice matcher failed: ${err.message}`));
  proc.on("exit", (code, signal) => {
    const why = stderrTail.trim().split(/\r?\n/).pop() ?? "";
    bury(`Voice matcher exited (${signal ?? code})${why ? `: ${why}` : ""}`);
  });
  live = self;
  return self;
}

export function disposeEmbedder(): void {
  try {
    live?.proc.kill();
  } catch {
    /* already gone */
  }
  live = null;
}

const EMBED_TIMEOUT_MS = 60_000;

/** The speaker vector for one clip. Null when the model is missing or the
 * child died — the caller reports it once, not per candidate. */
export async function embed(
  samples: Float32Array,
  sampleRate: number,
): Promise<Float32Array | null> {
  if (!speakerAvailable() || !(await speakerModelInstalled())) return null;
  const c = getChild();
  const id = ++seq;
  const reply = await new Promise<EmbedReply>((resolve) => {
    const timer = setTimeout(() => {
      if (!c.pending.has(id)) return;
      c.pending.delete(id);
      resolve({ id, type: "error", error: "Embedding timed out." });
    }, EMBED_TIMEOUT_MS);
    c.pending.set(id, (r: EmbedReply) => {
      clearTimeout(timer);
      resolve(r);
    });
    c.proc.send({
      id,
      type: "embed",
      model: speakerModelPath(),
      samples: Array.from(samples),
      sampleRate,
    });
  });
  if (reply.type === "error" || !reply.embedding) return null;
  return Float32Array.from(reply.embedding);
}

/** How alike two voices are: 1 is the same speaker, 0 is unrelated. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

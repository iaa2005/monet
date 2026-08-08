/**
 * Installing and running the on-device voice (Supertonic 3).
 *
 * The same shape as stt/gigaam.ts, deliberately: downloads land in
 * `<dataDir>/tts-models/supertonic-3/`, every file goes to `.part` first and
 * is checked against its published sha256 (the STT downloader once produced a
 * right-sized file with wrong bytes — that mistake is not getting a second
 * chance), and the synthesiser lives in a forked child so main never blocks.
 *
 * Voices are ~290 KB style tensors: installing one is cheap, so the voice
 * picker installs them on selection without ceremony. The 398 MB model
 * downloads once, explicitly.
 */

import { fork, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { createWriteStream, existsSync } from "fs";
import { mkdir, rm, rename, stat } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { getDataDir } from "../data-dir.js";
import {
  TTS_MODEL_FILES,
  TTS_VOICES,
  ttsFileName,
  ttsFileUrl,
  ttsModelBytes,
  voiceFile,
  type TtsFile,
} from "./catalog.js";
import { listCustomVoices } from "./custom-voices.js";
import { isCustomVoice, modelDir, stylePathFor } from "./paths.js";

const require = createRequire(import.meta.url);

export interface TtsStatus {
  installed: boolean;
  bytes: number;
  installing: boolean;
  voices: {
    id: string;
    name: string;
    desc: string;
    installed: boolean;
    /** Its voice map — see shared/voice-map.ts. */
    art?: string;
    /** Imported or blended, so it has no download and can be deleted. */
    custom?: boolean;
  }[];
}

export interface TtsProgress {
  loaded: number;
  total: number;
  percent: number;
  done?: boolean;
  error?: string;
}

export function ttsNativeAvailable(): boolean {
  try {
    require.resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

async function filePresent(dir: string, f: TtsFile): Promise<boolean> {
  try {
    const s = await stat(join(dir, ttsFileName(f)));
    return s.isFile() && s.size === f.bytes;
  } catch {
    return false;
  }
}

export async function modelInstalled(): Promise<boolean> {
  for (const f of TTS_MODEL_FILES) {
    if (!(await filePresent(modelDir(), f))) return false;
  }
  return true;
}

async function voiceInstalled(id: string): Promise<boolean> {
  const f = voiceFile(id);
  return f ? filePresent(modelDir(), f) : false;
}

let installing: AbortController | null = null;

export async function ttsStatus(): Promise<TtsStatus> {
  const voices: TtsStatus["voices"] = [];
  for (const v of TTS_VOICES) {
    voices.push({
      id: v.id,
      name: v.name,
      desc: v.desc,
      art: v.art,
      installed: await voiceInstalled(v.id),
    });
  }
  // Imported and blended voices are already here — nothing to download and no
  // catalogue entry to be missing, so they are always "installed".
  for (const c of listCustomVoices()) {
    voices.push({
      id: c.id,
      name: c.name,
      desc: "Your own voice",
      art: c.art,
      installed: true,
      custom: true,
    });
  }
  return {
    installed: await modelInstalled(),
    bytes: ttsModelBytes(),
    installing: installing !== null,
    voices,
  };
}

async function fetchFile(
  f: TtsFile,
  signal: AbortSignal | undefined,
  onChunk: (n: number) => void,
): Promise<void> {
  const dir = modelDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, ttsFileName(f));
  const part = `${target}.part`;
  const res = await fetch(ttsFileUrl(f), { signal });
  if (!res.ok || !res.body) throw new Error(`${ttsFileName(f)}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onChunk(chunk.length);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(part));
  const digest = hash.digest("hex");
  if (f.sha256 && digest !== f.sha256)
    throw new Error(`${ttsFileName(f)} arrived corrupt (checksum mismatch) — try again`);
  const written = (await stat(part)).size;
  if (written !== f.bytes)
    throw new Error(`${ttsFileName(f)}: expected ${f.bytes} bytes, got ${written}`);
  await rename(part, target);
}

/** The shared model + the default voice, one overall percentage. */
export async function installTts(
  firstVoice: string,
  onProgress: (p: TtsProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (installing) return { ok: false, error: "Already downloading" };
  installing = new AbortController();
  const vf = voiceFile(firstVoice);
  const files = [...TTS_MODEL_FILES, ...(vf ? [vf] : [])];
  const total = files.reduce((n, f) => n + f.bytes, 0);
  let loaded = 0;
  let lastPercent = -1;
  try {
    for (const f of files) {
      if (await filePresent(modelDir(), f)) {
        loaded += f.bytes;
        continue;
      }
      await fetchFile(f, installing.signal, (n) => {
        loaded += n;
        const percent = Math.min(99, Math.floor((loaded / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress({ loaded, total, percent });
        }
      });
    }
    onProgress({ loaded: total, total, percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    const error = installing.signal.aborted
      ? "Download cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
    // Only whole files ever count as installed, so a failed run needs no
    // directory wipe here — the .part is overwritten next time.
    onProgress({ loaded, total, percent: 0, done: true, error });
    return { ok: false, error };
  } finally {
    installing = null;
  }
}

export function cancelTtsInstall(): boolean {
  if (!installing) return false;
  installing.abort();
  return true;
}

/** A single ~290 KB style file — cheap enough to fetch on selection. */
export async function installVoice(id: string): Promise<{ ok: boolean; error?: string }> {
  const f = voiceFile(id);
  if (!f) return { ok: false, error: `Unknown voice ${id}` };
  if (await filePresent(modelDir(), f)) return { ok: true };
  try {
    await fetchFile(f, undefined, () => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Removes the 398 MB model and the preset styles — NOT `tts-models/custom`.
 * An imported voice cannot be re-downloaded: for some of them the builder that
 * made them no longer exists, so "free up the disk" must not take them. */
export async function removeTts(): Promise<{ ok: boolean }> {
  cancelTtsInstall();
  disposeChild();
  await rm(modelDir(), { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

/** Drop the synthesiser (and with it its style cache). Called after a custom
 * voice is imported or deleted: the child caches styles BY PATH, and an id
 * reused after a deletion would otherwise keep speaking in the old voice. */
export function resetVoiceCache(): void {
  disposeChild();
}

// ── The synthesiser process ─────────────────────────────────────────────

interface ChildReply {
  id: number;
  type: "result" | "error";
  samples?: string;
  sampleRate?: number;
  ms?: number;
  error?: string;
}

let child: ChildProcess | null = null;
let seq = 0;
const pending = new Map<number, (r: ChildReply) => void>();

function failAllPending(error: string): void {
  for (const [, resolve] of pending) resolve({ id: 0, type: "error", error });
  pending.clear();
}

function getChild(): ChildProcess {
  if (child && child.connected) return child;
  const script = fileURLToPath(new URL("./supertonic-child.js", import.meta.url));
  child = fork(script, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderrTail = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-800);
  });
  child.on("message", (msg: ChildReply) => {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg);
  });
  child.on("error", (err) => {
    failAllPending(`Voice process failed: ${err.message}`);
    child = null;
  });
  child.on("exit", (code, signal) => {
    const why = stderrTail.trim().split(/\r?\n/).pop() ?? "";
    failAllPending(`Voice process exited (${signal ?? code})${why ? `: ${why}` : ""}`);
    child = null;
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
}

const SPEAK_TIMEOUT_MS = 60_000;

export interface SpeakResult {
  ok: boolean;
  /** Base64 of Float32 PCM — the renderer feeds it to an AudioBuffer. */
  samplesBase64?: string;
  sampleRate?: number;
  ms?: number;
  error?: string;
}

export async function speak(p: {
  text: string;
  voice: string;
  lang?: string;
  steps?: number;
  speed?: number;
}): Promise<SpeakResult> {
  if (!ttsNativeAvailable())
    return { ok: false, error: "On-device voice is not available on this platform." };
  if (!(await modelInstalled()))
    return { ok: false, error: "The voice model is not downloaded yet." };
  // An imported voice has no catalogue entry and nothing to fetch: its file is
  // the only thing that can be missing.
  const custom = isCustomVoice(p.voice);
  const voicePath = stylePathFor(p.voice);
  if (custom) {
    if (!existsSync(voicePath))
      return { ok: false, error: `The file for voice ${p.voice} is gone — import it again.` };
  } else {
    const vf = voiceFile(p.voice);
    if (!vf) return { ok: false, error: `Unknown voice ${p.voice}` };
    if (!(await filePresent(modelDir(), vf))) {
      const got = await installVoice(p.voice);
      if (!got.ok) return { ok: false, error: got.error };
    }
  }

  const c = getChild();
  const id = ++seq;
  const reply = await new Promise<ChildReply>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      disposeChild();
      resolve({ id, type: "error", error: "Synthesis timed out." });
    }, SPEAK_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    c.send({
      id,
      type: "speak",
      modelDir: modelDir(),
      voicePath,
      text: p.text,
      lang: p.lang || "na",
      steps: p.steps ?? 8,
      speed: p.speed ?? 1.05,
    });
  });
  if (reply.type === "error") return { ok: false, error: reply.error };
  return {
    ok: true,
    samplesBase64: reply.samples,
    sampleRate: reply.sampleRate,
    ms: reply.ms,
  };
}

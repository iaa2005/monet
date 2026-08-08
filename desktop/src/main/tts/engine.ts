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

/**
 * Download to `target`, checked. Shared with the speaker model next door: the
 * STT downloader once produced a right-sized file with the wrong bytes, and
 * that mistake is not getting a second chance anywhere.
 */
export async function fetchChecked(p: {
  url: string;
  target: string;
  bytes: number;
  sha256?: string;
  signal?: AbortSignal;
  onChunk?: (n: number) => void;
}): Promise<void> {
  const name = p.target.split(/[\\/]/).pop() as string;
  const part = `${p.target}.part`;
  const res = await fetch(p.url, { signal: p.signal });
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      p.onChunk?.(chunk.length);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(part));
  const digest = hash.digest("hex");
  if (p.sha256 && digest !== p.sha256)
    throw new Error(`${name} arrived corrupt (checksum mismatch) — try again`);
  const written = (await stat(part)).size;
  if (written !== p.bytes)
    throw new Error(`${name}: expected ${p.bytes} bytes, got ${written}`);
  await rename(part, p.target);
}

async function fetchFile(
  f: TtsFile,
  signal: AbortSignal | undefined,
  onChunk: (n: number) => void,
): Promise<void> {
  const dir = modelDir();
  await mkdir(dir, { recursive: true });
  await fetchChecked({
    url: ttsFileUrl(f),
    target: join(dir, ttsFileName(f)),
    bytes: f.bytes,
    sha256: f.sha256,
    signal,
    onChunk,
  });
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

/**
 * Make the synthesiser forget one style file.
 *
 * It caches styles BY PATH, so a file written again at the same path — every
 * blend preview, and any id reused after a deletion — would keep speaking in
 * the previous voice. Killing the child would also do it, and did: that cost
 * the ~2 s model load on the next utterance, which for a slider you drag is
 * the difference between an instrument and a wait. A one-line message is
 * enough, and the 400 MB stays loaded.
 */
export function forgetVoiceStyle(id: string): void {
  if (!live?.proc.connected) return;
  try {
    live.proc.send({ id: 0, type: "forget", voicePath: stylePathFor(id) });
  } catch {
    /* a dead child has no cache to clear */
  }
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

/**
 * One live synthesiser and the requests waiting on IT.
 *
 * The pending map used to be module-global, shared by every child that had
 * ever been forked — so a child that died AFTER its replacement had been
 * started failed the new child's in-flight request. Symptom: "Voice process
 * exited (SIGTERM)" on a perfectly healthy synthesis, every time something
 * disposed the child and spoke immediately after (which the blend preview
 * did, on purpose, to drop a cached style).
 */
interface VoiceChild {
  proc: ChildProcess;
  pending: Map<number, (r: ChildReply) => void>;
}

let live: VoiceChild | null = null;
let seq = 0;

function getChild(): VoiceChild {
  if (live && live.proc.connected) return live;
  const script = fileURLToPath(new URL("./supertonic-child.js", import.meta.url));
  const proc = fork(script, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const self: VoiceChild = { proc, pending: new Map() };
  let stderrTail = "";
  proc.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-800);
  });
  proc.on("message", (msg: ChildReply) => {
    const resolve = self.pending.get(msg.id);
    if (!resolve) return;
    self.pending.delete(msg.id);
    resolve(msg);
  });
  /** Fails only what THIS child was carrying, and only clears the slot if it
   * is still the current one. */
  const bury = (error: string): void => {
    for (const [, resolve] of self.pending) resolve({ id: 0, type: "error", error });
    self.pending.clear();
    if (live === self) live = null;
  };
  proc.on("error", (err) => bury(`Voice process failed: ${err.message}`));
  proc.on("exit", (code, signal) => {
    const why = stderrTail.trim().split(/\r?\n/).pop() ?? "";
    bury(`Voice process exited (${signal ?? code})${why ? `: ${why}` : ""}`);
  });
  live = self;
  return self;
}

function disposeChild(): void {
  try {
    live?.proc.kill();
  } catch {
    /* already gone */
  }
  live = null;
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

  return dispatch({
    voicePath,
    text: p.text,
    lang: p.lang || "na",
    steps: p.steps ?? 8,
    speed: p.speed ?? 1.05,
  });
}

async function dispatch(payload: {
  voicePath: string;
  text: string;
  lang: string;
  steps: number;
  speed: number;
}): Promise<SpeakResult> {
  const c = getChild();
  const id = ++seq;
  const reply = await new Promise<ChildReply>((resolve) => {
    const timer = setTimeout(() => {
      if (!c.pending.has(id)) return;
      c.pending.delete(id);
      disposeChild();
      resolve({ id, type: "error", error: "Synthesis timed out." });
    }, SPEAK_TIMEOUT_MS);
    c.pending.set(id, (r: ChildReply) => {
      clearTimeout(timer);
      resolve(r);
    });
    c.proc.send({ id, type: "speak", modelDir: modelDir(), ...payload });
  });
  if (reply.type === "error") return { ok: false, error: reply.error };
  return {
    ok: true,
    samplesBase64: reply.samples,
    sampleRate: reply.sampleRate,
    ms: reply.ms,
  };
}

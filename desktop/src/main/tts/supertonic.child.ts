/**
 * The Supertonic 3 synthesiser, in a process of its own.
 *
 * Same reasoning as the GigaAM recognizer next door (stt/gigaam.child.ts):
 * onnxruntime is a native module, ~400 MB of weights load for about two
 * seconds, and a flow-matching step is a blocking C call. None of that may
 * sit on main's event loop, and a native crash here costs one utterance, not
 * the session.
 *
 * The pipeline is a TypeScript port of the official MIT-licensed Node example
 * (supertone-inc/supertonic nodejs/helper.js): text → unicode ids → duration
 * predictor → text encoder → N flow-matching steps → vocoder. Ported rather
 * than depended on because the example is a demo script (reads argv, writes
 * files) and this needs a long-lived process with an IPC surface.
 *
 * All four sessions and the voice styles are kept loaded between utterances —
 * in a voice conversation the second sentence must not pay the two-second
 * model load again.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtTensor = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtSession = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ort = require("onnxruntime-node") as any;

interface SpeakRequest {
  id: number;
  type: "speak" | "forget";
  /** Directory holding the six model files. */
  modelDir: string;
  /** Absolute path of the voice style JSON. */
  voicePath: string;
  text: string;
  /** BCP-47-ish two-letter code, or "na" for language-agnostic. */
  lang: string;
  /** Flow-matching steps: 4 = fast, 8 = best. */
  steps: number;
  speed: number;
}

interface Loaded {
  dp: OrtSession;
  textEnc: OrtSession;
  vectorEst: OrtSession;
  vocoder: OrtSession;
  indexer: Record<string, number>;
  sampleRate: number;
  baseChunkSize: number;
  chunkCompressFactor: number;
  latentDim: number;
}

let loaded: Loaded | null = null;
let loadedDir = "";
const styles = new Map<string, { ttl: OrtTensor; dp: OrtTensor }>();

async function load(modelDir: string): Promise<Loaded> {
  if (loaded && loadedDir === modelDir) return loaded;
  loaded = null;
  styles.clear();
  const cfg = JSON.parse(readFileSync(join(modelDir, "tts.json"), "utf8"));
  const opts = {};
  const [dp, textEnc, vectorEst, vocoder] = await Promise.all([
    ort.InferenceSession.create(join(modelDir, "duration_predictor.onnx"), opts),
    ort.InferenceSession.create(join(modelDir, "text_encoder.onnx"), opts),
    ort.InferenceSession.create(join(modelDir, "vector_estimator.onnx"), opts),
    ort.InferenceSession.create(join(modelDir, "vocoder.onnx"), opts),
  ]);
  loaded = {
    dp,
    textEnc,
    vectorEst,
    vocoder,
    indexer: JSON.parse(readFileSync(join(modelDir, "unicode_indexer.json"), "utf8")),
    sampleRate: cfg.ae.sample_rate,
    baseChunkSize: cfg.ae.base_chunk_size,
    chunkCompressFactor: cfg.ttl.chunk_compress_factor,
    latentDim: cfg.ttl.latent_dim,
  };
  loadedDir = modelDir;
  return loaded;
}

function style(voicePath: string): { ttl: OrtTensor; dp: OrtTensor } {
  const cached = styles.get(voicePath);
  if (cached) return cached;
  const v = JSON.parse(readFileSync(voicePath, "utf8"));
  const flat = (x: unknown): number[] => (Array.isArray(x) ? x.flat(Infinity) as number[] : []);
  const s = {
    ttl: new ort.Tensor("float32", Float32Array.from(flat(v.style_ttl.data)), [
      1,
      v.style_ttl.dims[1],
      v.style_ttl.dims[2],
    ]),
    dp: new ort.Tensor("float32", Float32Array.from(flat(v.style_dp.data)), [
      1,
      v.style_dp.dims[1],
      v.style_dp.dims[2],
    ]),
  };
  styles.set(voicePath, s);
  return s;
}

/** The example's text cleanup, minus the file-writing demo trimmings. */
function preprocess(text: string, lang: string): string {
  let t = text.normalize("NFKD");
  t = t.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
    "",
  );
  const map: Record<string, string> = {
    "–": "-", "‑": "-", "—": "-", _: " ", "“": '"', "”": '"',
    "‘": "'", "’": "'", "´": "'", "`": "'", "[": " ", "]": " ",
    "|": " ", "/": " ", "#": " ", "→": " ", "←": " ",
  };
  for (const [k, v] of Object.entries(map)) t = t.split(k).join(v);
  t = t.replace(/[♥☆♡©\\]/g, "");
  t = t.replace(/ ([,.!?;:'])/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += ".";
  return `<${lang}>${t}</${lang}>`;
}

function lengthMask(len: number): Float32Array {
  return new Float32Array(len).fill(1);
}

/**
 * The model's real input budget: the official example never feeds it more
 * than 300 characters at once (120 for ko/ja) — past that the duration
 * predictor drifts and the speech races or mumbles. Split at sentence ends
 * first, then commas, then any whitespace; each piece goes through the full
 * pipeline and the wavs are joined with a short breath of silence.
 */
function splitForModel(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const cutAt = (re: RegExp): number => {
      let last = -1;
      for (const m of window.matchAll(re)) last = m.index + m[0].length;
      return last;
    };
    // A cut in the first fifth trades one oversized piece for a fragment
    // that mumbles — prefer the later boundary kinds instead.
    const min = Math.floor(maxLen / 5);
    let cut = cutAt(/[.!?…]["»)]?\s/g);
    if (cut < min) cut = cutAt(/[,;:]\s/g);
    if (cut < min) cut = cutAt(/\s+/g);
    if (cut < min) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter((p) => /[\p{L}\p{N}]/u.test(p));
}

async function synthesizeOne(
  req: SpeakRequest,
  piece: string,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const m = await load(req.modelDir);
  const s = style(req.voicePath);

  const text = preprocess(piece, req.lang);
  const ids = Array.from(text).map((ch) => m.indexer[String(ch.charCodeAt(0))] ?? 0);
  const n = ids.length;
  const textIds = new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]);
  const textMask = new ort.Tensor("float32", lengthMask(n), [1, 1, n]);

  const dpOut = await m.dp.run({ text_ids: textIds, style_dp: s.dp, text_mask: textMask });
  const durationSec = Number(dpOut.duration.data[0]) / req.speed;

  const encOut = await m.textEnc.run({ text_ids: textIds, style_ttl: s.ttl, text_mask: textMask });

  const chunk = m.baseChunkSize * m.chunkCompressFactor;
  const wavLen = Math.floor(durationSec * m.sampleRate);
  const latentLen = Math.max(1, Math.floor((wavLen + chunk - 1) / chunk));
  const latentDim = m.latentDim * m.chunkCompressFactor;

  // Box-Muller noise, masked to the audible length (mask is all-ones for a
  // single utterance, kept for parity with the reference implementation).
  const latent = new Float32Array(latentDim * latentLen);
  for (let i = 0; i < latent.length; i++) {
    const u1 = Math.max(1e-10, Math.random());
    latent[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
  }
  const latentShape = [1, latentDim, latentLen];
  const latentMask = new ort.Tensor("float32", lengthMask(latentLen), [1, 1, latentLen]);
  const totalStep = new ort.Tensor("float32", Float32Array.from([req.steps]), [1]);

  let current = latent;
  for (let step = 0; step < req.steps; step++) {
    const out = await m.vectorEst.run({
      noisy_latent: new ort.Tensor("float32", current, latentShape),
      text_emb: encOut.text_emb,
      style_ttl: s.ttl,
      text_mask: textMask,
      latent_mask: latentMask,
      total_step: totalStep,
      current_step: new ort.Tensor("float32", Float32Array.from([step]), [1]),
    });
    current = new Float32Array(out.denoised_latent.data as Float32Array);
  }

  const voc = await m.vocoder.run({
    latent: new ort.Tensor("float32", current, latentShape),
  });
  let samples = voc.wav_tts.data as Float32Array;
  // The vocoder pads to whole latent chunks; cut back to the predicted length
  // so queued sentences don't get silence gaps between them.
  if (samples.length > wavLen && wavLen > 0) samples = samples.slice(0, wavLen);
  return { samples, sampleRate: m.sampleRate };
}

/** Long text goes through in model-sized pieces, joined by a short breath. */
async function synthesize(req: SpeakRequest): Promise<{ samples: Float32Array; sampleRate: number }> {
  const maxLen = req.lang === "ko" || req.lang === "ja" ? 120 : 300;
  const pieces = splitForModel(req.text, maxLen);
  if (pieces.length === 0) {
    return { samples: new Float32Array(0), sampleRate: (await load(req.modelDir)).sampleRate };
  }
  if (pieces.length === 1) return synthesizeOne(req, pieces[0]);
  const parts: Float32Array[] = [];
  let sampleRate = 44100;
  for (const p of pieces) {
    const r = await synthesizeOne(req, p);
    sampleRate = r.sampleRate;
    parts.push(r.samples);
  }
  const gap = Math.floor(sampleRate * 0.12);
  const total = parts.reduce((n, s) => n + s.length, 0) + gap * (parts.length - 1);
  const joined = new Float32Array(total);
  let at = 0;
  for (const s of parts) {
    joined.set(s, at);
    at += s.length + gap;
  }
  return { samples: joined, sampleRate };
}

process.on("message", (req: SpeakRequest) => {
  // A style file rewritten at the same path (every blend preview) must not
  // keep speaking out of this cache. Cheaper than a restart by two seconds of
  // model loading, which is the whole point of a long-lived child.
  if (req?.type === "forget") {
    styles.delete(req.voicePath);
    return;
  }
  if (req?.type !== "speak") return;
  void (async () => {
    try {
      const t0 = Date.now();
      const { samples, sampleRate } = await synthesize(req);
      process.send?.(
        {
          id: req.id,
          type: "result",
          sampleRate,
          ms: Date.now() - t0,
          // A plain transferable copy: process IPC serialises typed arrays.
          samples: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64"),
        },
      );
    } catch (err) {
      process.send?.({
        id: req.id,
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

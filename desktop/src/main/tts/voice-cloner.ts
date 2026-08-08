/**
 * Handing over the voice cloner.
 *
 * Real cloning needs gradients through the model, and the app's onnxruntime
 * does inference only — so the cloner is a Python program, and this is what
 * gets it ready: the project files next to the model, the recording written as
 * a WAV beside them, and a command to run.
 *
 * `<dataDir>/voice-cloner/` deliberately: it sits next to `tts-models/`, so
 * clone.py finds the 398 MB model with no path to configure, and the folder
 * survives an app update.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { getDataDir } from "../data-dir.js";

/** The template files shipped with the app. */
function templateDir(): string {
  // Packaged: resources/voice-cloner (electron-builder extraResources).
  // Dev: the repo folder next to src/.
  const packaged = join(process.resourcesPath ?? "", "voice-cloner");
  if (existsSync(packaged)) return packaged;
  return join(app.getAppPath(), "resources", "voice-cloner");
}

export function clonerDir(): string {
  const d = join(getDataDir(), "voice-cloner");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** 16-bit mono WAV — the one audio format everything reads without a codec. */
function writeWav(path: string, samples: Float32Array, sampleRate: number): void {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

export interface ClonerProject {
  ok: boolean;
  dir?: string;
  /** What to type, with the real paths already in it. */
  command?: string;
  /** Seconds of audio written. */
  seconds?: number;
  error?: string;
}

/**
 * Copy the project in and write the recording next to it. Overwrites the
 * recording (there is one voice being cloned) but never a result the user
 * already produced.
 */
export function prepareCloner(p: {
  samples: Float32Array;
  sampleRate: number;
  name: string;
  lang: string;
}): ClonerProject {
  const dir = clonerDir();
  const template = templateDir();
  if (!existsSync(join(template, "clone.py")))
    return { ok: false, error: `The cloner files are missing from ${template}.` };
  // Said here rather than after two gigabytes of pip: the optimisation runs the
  // real synthesiser, so the voice model has to be installed first.
  if (!existsSync(join(getDataDir(), "tts-models", "supertonic-3", "vocoder.onnx")))
    return {
      ok: false,
      error: "Download the voice model first — the cloner optimises against it.",
    };
  try {
    for (const f of readdirSync(template)) {
      const target = join(dir, f);
      // clone.py and the docs are ours to refresh on every prepare; anything
      // the user or a run produced (their JSON, the model cache) is not.
      copyFileSync(join(template, f), target);
    }
    writeWav(join(dir, "voice.wav"), p.samples, p.sampleRate);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot write the project" };
  }
  const stem = (p.name.trim() || "my-voice").replace(/["\\]/g, "");
  // --models spelled out, always. clone.py defaults to the folder next to
  // itself, which is right only while the cloner folder stays inside the data
  // dir that holds the model — and the very first person to run this had it in
  // a data dir where the voice was never installed. An absolute path cannot be
  // wrong.
  const models = join(getDataDir(), "tts-models", "supertonic-3");
  return {
    ok: true,
    dir,
    command:
      `python clone.py voice.wav --name "${stem}" --lang ${p.lang} ` +
      `--minutes 20 --models "${models}"`,
    seconds: p.samples.length / p.sampleRate,
  };
}

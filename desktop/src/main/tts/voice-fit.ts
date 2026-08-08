/**
 * A voice built from your own recording.
 *
 * What is NOT possible: Supertonic ships no style encoder, so a recording
 * cannot be turned into a style directly. Supertone's own builder does it
 * server-side and charges $49; the community route optimises a tensor against
 * a speaker-identity model in PyTorch for hours.
 *
 * What IS possible on this machine, with what is already installed: search.
 * The pieces are all here — the synthesiser can speak any style handed to it,
 * and a 29 MB speaker model can say how close two voices sound. So:
 *
 *   speak a candidate → embed it → cosine against the recording → keep the best
 *
 * The search space is the honest compromise. The style is 12 928 numbers and
 * every evaluation costs a real synthesis, so blind search in that space is
 * hopeless. Instead the candidates live in the span of the ten presets:
 * s = Σ wᵢ·sᵢ, ten numbers to fit. That makes the result a BLEND — the same
 * object the blender saves — chosen by your voice instead of by hand. It lands
 * on the closest voice the model can build out of what it has, which is a
 * family resemblance and not a clone. The UI says so.
 *
 * The loop is a (1+λ) evolution strategy: score all ten presets, start from the
 * best, then repeatedly perturb the weights, keep improvements, and shrink the
 * step when a round brings none. Sixty-odd evaluations, about a minute and a
 * half — no gradients, nothing to train, nothing leaves the machine.
 */

import { existsSync } from "fs";
import { TTS_VOICES } from "./catalog.js";
import { installVoice, speakStyle } from "./engine.js";
import { stylePathFor } from "./paths.js";
import { readStyleFile, type StyleTensors } from "./style-map.js";
import { cosine, embed, speakerModelInstalled } from "./speaker.js";
import { blendTensors, type MixPart } from "./voice-mix.js";

/** Enough speech for a stable embedding, short enough to synthesise fast. */
const FIT_TEXT: Record<string, string> = {
  ru: "Проверяю, как звучит этот голос на длинной фразе с обычными словами.",
  en: "Checking how this voice sounds on a longer sentence of ordinary words.",
};

export interface FitProgress {
  step: number;
  total: number;
  /** Best cosine similarity so far. */
  best: number;
}

export interface FitResult {
  ok: boolean;
  parts?: MixPart[];
  /** Cosine similarity of the winner, 0…1. */
  score?: number;
  /** Similarity of the best single preset, for "was the search worth it". */
  baseScore?: number;
  error?: string;
}

/** Rounds × candidates per round, on top of the ten presets. */
const ROUNDS = 8;
const PER_ROUND = 6;

/** Box-Muller, seeded by nothing: a search does not need reproducibility, and
 * two runs finding two different good voices is a feature. */
function gauss(sigma: number): number {
  const u = Math.max(1e-9, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()) * sigma;
}

export async function fitVoice(p: {
  /** The user's recording. Any sample rate; the embedder resamples. */
  samples: Float32Array;
  sampleRate: number;
  lang?: string;
  onProgress?: (p: FitProgress) => void;
  /** Polled between evaluations — a minute is long enough to change your mind. */
  cancelled?: () => boolean;
}): Promise<FitResult> {
  if (!(await speakerModelInstalled()))
    return { ok: false, error: "The voice matcher is not downloaded yet." };
  if (p.samples.length < p.sampleRate * 3)
    return { ok: false, error: "Too short — record at least three or four seconds." };

  const target = await embed(p.samples, p.sampleRate);
  if (!target) return { ok: false, error: "Could not read the recording." };

  // Every preset has to be on disk: the search reads their tensors. 0.3 MB each.
  for (const v of TTS_VOICES) {
    if (!existsSync(stylePathFor(v.id))) {
      const got = await installVoice(v.id);
      if (!got.ok) return { ok: false, error: got.error };
    }
  }
  const styles: StyleTensors[] = [];
  for (const v of TTS_VOICES) {
    const s = readStyleFile(stylePathFor(v.id));
    if (!s) return { ok: false, error: `${v.name}'s style file is unreadable.` };
    styles.push(s);
  }

  const lang = p.lang && FIT_TEXT[p.lang] ? p.lang : "ru";
  const text = FIT_TEXT[lang];
  const total = TTS_VOICES.length + ROUNDS * PER_ROUND;
  let step = 0;
  let best = -1;
  let bestW: number[] = [];

  const score = async (w: number[]): Promise<number> => {
    const r = await speakStyle({ style: blendTensors(styles, w), text, lang, steps: 4 });
    if (!r.ok || !r.samplesBase64) return -1;
    const buf = Buffer.from(r.samplesBase64, "base64");
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const e = await embed(pcm, r.sampleRate ?? 44_100);
    return e ? cosine(target, e) : -1;
  };

  // Round one: which of the ten is nearest at all.
  for (let k = 0; k < TTS_VOICES.length; k++) {
    if (p.cancelled?.()) return { ok: false, error: "Cancelled" };
    const w = new Array<number>(TTS_VOICES.length).fill(0);
    w[k] = 1;
    const s = await score(w);
    if (s > best) {
      best = s;
      bestW = w;
    }
    p.onProgress?.({ step: ++step, total, best });
  }
  if (best < 0) return { ok: false, error: "Synthesis failed — is the voice model installed?" };
  const baseScore = best;

  // Then walk: perturb, keep improvements, shrink when a round brings none.
  let sigma = 0.4;
  for (let round = 0; round < ROUNDS; round++) {
    let improved = false;
    for (let c = 0; c < PER_ROUND; c++) {
      if (p.cancelled?.()) break;
      // Small negative weights are allowed: "less like James" is a direction
      // too, and clamping at zero would only ever interpolate inwards.
      const w = bestW.map((x) => Math.max(-0.3, x + gauss(sigma)));
      const s = await score(w);
      if (s > best) {
        best = s;
        bestW = w;
        improved = true;
      }
      p.onProgress?.({ step: ++step, total, best });
    }
    if (p.cancelled?.()) break;
    if (!improved) sigma *= 0.6;
  }

  const totalW = bestW.reduce((n, x) => n + Math.abs(x), 0) || 1;
  // EVERY weight, including the small ones. Dropping the tail would look
  // tidier and would change the voice: the blender normalises by the sum of
  // what it is handed, so pruning 7% of the mass scales the rest up by 7% —
  // and the voice saved would no longer be the voice that was scored.
  const parts: MixPart[] = TTS_VOICES.map((v, k) => ({
    id: v.id,
    weight: bestW[k] / totalW,
  })).filter((x) => x.weight !== 0);

  return { ok: true, parts, score: best, baseScore };
}

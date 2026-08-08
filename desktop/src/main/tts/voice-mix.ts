/**
 * Blending voices — the way to a voice of your own that costs nothing.
 *
 * Supertone's Voice Builder wants $49 per voice and, as of August 2026, sells
 * none at all ("Purchases Unavailable"): you can hear your voice on their page
 * and not download it. There is no public style ENCODER either, so extracting
 * a style from a recording locally is out (the community route is an
 * optimisation loop against a speaker-identity model — hours, PyTorch, and a
 * likeness rather than a clone).
 *
 * What IS possible with what is already on disk: the style is a point in a
 * latent space, and a convex combination of points in it is another voice.
 * That is what Topping1's Supertonic-Voice-Mixer does (issue #44), and the
 * arithmetic is small enough to belong in the app rather than in a Python GUI.
 *
 * Weights are normalised, so a mix is an average and never a scaling: doubling
 * every weight must not double the tensor, or the voice comes out shouting.
 */

import { existsSync, writeFileSync } from "fs";
import {
  STYLE_FEATURES,
  STYLE_TOKENS,
} from "@shared/voice-map.js";
import { customVoicePath, stylePathFor } from "./paths.js";
import { readStyleFile } from "./style-map.js";
import { registerCustomVoice } from "./custom-voices.js";

export interface MixPart {
  /** Preset id (F1…M5) or a custom one. */
  id: string;
  /** Any non-negative number; only the ratios matter. */
  weight: number;
}

const DP_LEN = 8 * 16;

/** The blended style, as the JSON text a style file holds. */
export function mixStyles(
  parts: MixPart[],
): { ok: true; json: string } | { ok: false; error: string } {
  const usable = parts.filter((p) => p.weight > 0);
  if (usable.length < 2) return { ok: false, error: "Pick two voices to blend." };
  const total = usable.reduce((n, p) => n + p.weight, 0);
  if (!(total > 0)) return { ok: false, error: "Give at least one voice some weight." };

  const ttl = new Array<number>(STYLE_TOKENS * STYLE_FEATURES).fill(0);
  const dp = new Array<number>(DP_LEN).fill(0);
  for (const p of usable) {
    const path = stylePathFor(p.id);
    if (!existsSync(path))
      return { ok: false, error: `${p.id} is not downloaded yet — select it once first.` };
    const style = readStyleFile(path);
    if (!style || style.ttl.length !== ttl.length || style.dp.length !== dp.length)
      return { ok: false, error: `${p.id} is not a Supertonic 3 style file.` };
    const w = p.weight / total;
    for (let i = 0; i < ttl.length; i++) ttl[i] += style.ttl[i] * w;
    for (let i = 0; i < dp.length; i++) dp[i] += style.dp[i] * w;
  }

  // Both tensors travel: style_dp carries the rhythm, and blending timbre
  // while keeping one parent's timing sounds like the wrong person's pacing.
  return {
    ok: true,
    json: JSON.stringify({
      style_ttl: { dims: [1, STYLE_TOKENS, STYLE_FEATURES], data: ttl, type: "float32" },
      style_dp: { dims: [1, 8, 16], data: dp, type: "float32" },
      metadata: { source: "blend", parts: parts.map((p) => `${p.id}:${p.weight}`) },
    }),
  };
}

export interface MixResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Save a blend as a voice of its own. */
export function mixCustomVoice(p: {
  parts: MixPart[];
  name: string;
  gender: "F" | "M";
}): MixResult {
  const name = p.name.trim();
  if (!name) return { ok: false, error: "Give the voice a name." };
  const mixed = mixStyles(p.parts);
  if (!mixed.ok) return { ok: false, error: mixed.error };
  return registerCustomVoice({ gender: p.gender, name, json: mixed.json });
}

/**
 * A blend to listen to before naming it.
 *
 * Written under a fixed id that is deliberately NOT registered: the picker
 * lists the registry, so the preview is speakable and invisible. One file per
 * gender, overwritten every time — a preview is not a voice.
 */
export function previewMix(p: { parts: MixPart[]; gender: "F" | "M" }): MixResult {
  const mixed = mixStyles(p.parts);
  if (!mixed.ok) return { ok: false, error: mixed.error };
  const id = `${p.gender}-preview`;
  try {
    writeFileSync(customVoicePath(id), mixed.json, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot write the preview" };
  }
  return { ok: true, id };
}

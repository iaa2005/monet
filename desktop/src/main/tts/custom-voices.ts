/**
 * Voices of your own.
 *
 * A Supertonic voice is not a model: it is two style tensors in a ~290 KB JSON
 * file, and the 398 MB model already on disk speaks with whichever pair it is
 * handed. Supertone's voice builder (supertonic.supertone.ai/voice-builder)
 * turns a minute of recorded audio into exactly that file, so a voice built
 * there drops in beside the presets with nothing else to install.
 *
 * Worth knowing while it lasts: the builder's own notice says sign-ups and
 * purchases ended 23 July 2026 and the service closes 31 August 2026. A JSON
 * already downloaded keeps working forever — synthesis never leaves this
 * machine, so there is no service to be closed.
 *
 * Ids are `<gender>-<slug>` (F-marina, M-sasha). The gender is IN the id
 * because a spoken Russian reply has to agree with it, and the app reads that
 * from the id's first letter for presets already (MessageInput → voiceGender).
 * One rule for both kinds beats a second lookup that can disagree.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

/** The shape every preset has, and therefore the shape the model expects.
 * A Supertonic 2 embedding is the same file format with different dims — it
 * loads and then fails deep inside onnxruntime, so it is refused up front. */
const STYLE_TTL_DIMS = [1, 50, 256];
const STYLE_DP_DIMS = [1, 8, 16];

/** A style file is ~290 KB. Ten times that is not a voice. */
const MAX_BYTES = 3_000_000;

export interface CustomVoice {
  /** `F-<slug>` / `M-<slug>`. */
  id: string;
  name: string;
  bytes: number;
}

export function customVoicesDir(): string {
  const d = join(getDataDir(), "tts-models", "custom");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Preset ids are two characters and hold no dash; a custom id always does.
 * Strict on purpose: this is also the guard that keeps an id — which arrives
 * over IPC — from becoming a path. Anything else is simply not a custom
 * voice, and the preset lookup rejects it by name.
 */
export function isCustomVoice(id: string): boolean {
  return /^[FM]-[a-z0-9Ѐ-ӿ-]{1,40}$/i.test(id);
}

export function customVoicePath(id: string): string {
  return join(customVoicesDir(), `${id}.json`);
}

const registryFile = (): string => join(customVoicesDir(), "voices.json");

type Registry = Record<string, { name: string }>;

function readRegistry(): Registry {
  try {
    const f = registryFile();
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, "utf-8")) as Registry;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeRegistry(r: Registry): void {
  writeFileSync(registryFile(), JSON.stringify(r, null, 2), "utf-8");
}

/** Only what is BOTH registered and on disk: a hand-deleted file must not
 * leave a voice in the picker that fails the moment it is selected. */
export function listCustomVoices(): CustomVoice[] {
  const reg = readRegistry();
  const out: CustomVoice[] = [];
  for (const [id, meta] of Object.entries(reg)) {
    const p = customVoicePath(id);
    if (!existsSync(p)) continue;
    out.push({ id, name: meta.name || id, bytes: statSync(p).size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Filename-safe, ASCII-ish, and never empty — Cyrillic names are common
 * here and `Марина` must not become an empty id. */
export function voiceSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || "voice";
}

export interface StyleCheck {
  ok: boolean;
  error?: string;
}

/**
 * Is this JSON a Supertonic 3 voice? Pure, so the failure the user sees is a
 * sentence rather than an onnxruntime shape error twenty seconds later.
 */
export function checkVoiceStyle(text: string): StyleCheck {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not a JSON file." };
  }
  if (!v || typeof v !== "object")
    return { ok: false, error: "Not a voice style file." };
  const obj = v as Record<string, unknown>;
  const flat = (x: unknown): number[] =>
    Array.isArray(x) ? (x.flat(Infinity) as number[]) : [];
  for (const [key, want] of [
    ["style_ttl", STYLE_TTL_DIMS],
    ["style_dp", STYLE_DP_DIMS],
  ] as const) {
    const t = obj[key] as { dims?: unknown; data?: unknown } | undefined;
    if (!t || typeof t !== "object")
      return { ok: false, error: `Missing "${key}" — this is not a voice style file.` };
    const dims = Array.isArray(t.dims) ? (t.dims as number[]) : [];
    if (dims.length !== want.length || dims.some((d, i) => d !== want[i]))
      return {
        ok: false,
        error: `"${key}" is ${dims.join("×") || "absent"}, expected ${want.join("×")} — that looks like a Supertonic 2 embedding. Download the Supertonic 3 JSON instead.`,
      };
    const n = flat(t.data).length;
    if (n !== want.reduce((a, b) => a * b, 1))
      return { ok: false, error: `"${key}" holds ${n} numbers, expected ${want.reduce((a, b) => a * b, 1)}.` };
    if (flat(t.data).some((x) => typeof x !== "number" || !Number.isFinite(x)))
      return { ok: false, error: `"${key}" contains values that are not numbers.` };
  }
  return { ok: true };
}

export interface ImportResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Copy a builder JSON in under a name and a gender. */
export function importCustomVoice(p: {
  path: string;
  name: string;
  gender: "F" | "M";
}): ImportResult {
  const name = p.name.trim();
  if (!name) return { ok: false, error: "Give the voice a name." };
  let text: string;
  try {
    const s = statSync(p.path);
    if (!s.isFile()) return { ok: false, error: "Not a file." };
    if (s.size > MAX_BYTES)
      return { ok: false, error: `That file is ${(s.size / 1e6).toFixed(1)} MB — a voice style is about 0.3 MB.` };
    text = readFileSync(p.path, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot read the file" };
  }
  const check = checkVoiceStyle(text);
  if (!check.ok) return { ok: false, error: check.error };

  const base = `${p.gender}-${voiceSlug(name)}`;
  const reg = readRegistry();
  let id = base;
  for (let n = 2; reg[id] || existsSync(customVoicePath(id)); n++) id = `${base}-${n}`;
  try {
    writeFileSync(customVoicePath(id), text, "utf-8");
    writeRegistry({ ...reg, [id]: { name } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "cannot save the voice" };
  }
  return { ok: true, id };
}

export function removeCustomVoice(id: string): { ok: boolean } {
  if (!isCustomVoice(id)) return { ok: false };
  const reg = readRegistry();
  delete reg[id];
  try {
    writeRegistry(reg);
    rmSync(customVoicePath(id), { force: true });
  } catch {
    /* the registry entry is gone either way */
  }
  return { ok: true };
}

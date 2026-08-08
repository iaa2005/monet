/**
 * Where voice files live.
 *
 * Three modules need the same two directories — the installer, the importer
 * and the mixer — and a wrong path here surfaces as "unknown voice" with
 * nothing to go on. One place, one rule.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getDataDir } from "../data-dir.js";

/** The shared 398 MB model and the ten preset styles. */
export function modelDir(): string {
  return join(getDataDir(), "tts-models", "supertonic-3");
}

/** Imported and blended voices. Deliberately outside modelDir: removing the
 * model must not take voices that cannot be downloaded again. */
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

/** The style file for any voice, preset or not. */
export function stylePathFor(id: string): string {
  return isCustomVoice(id) ? customVoicePath(id) : join(modelDir(), `${id}.json`);
}

/**
 * Dictation settings, in the data dir rather than the renderer.
 *
 * They used to live in localStorage, which is keyed by ORIGIN — and the dev
 * renderer's origin is `http://localhost:<port>`. When the port is taken vite
 * quietly moves to the next one, so the app came up on a different origin with
 * an empty store and the user's endpoint and API key looked wiped. They were
 * not: they were filed under the old port.
 *
 * The API key is also a secret, and it was the one secret in this app kept in
 * plain text — providers and connectors already encrypt theirs with
 * safeStorage (DPAPI / Keychain / libsecret). It does now too.
 */

import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./data-dir.js";
import { DEFAULT_STT_MODEL } from "./stt/catalog.js";

export interface SttSettings {
  /** "local" (in-renderer whisper), "ondevice" (GigaAM via sherpa-onnx in
   * main) or "cloud" (OpenAI-compatible endpoint). */
  engine: string;
  endpoint: string;
  /** Cloud only. Stored encrypted; travels to the renderer in the clear
   * because the renderer is what calls stt:transcribe with it. */
  key: string;
  model: string;
  localModel: string;
  /** Which downloaded GigaAM model the on-device engine uses. */
  nativeModel: string;
  /** "" = auto-detect. */
  language: string;
  /** MediaDevices deviceId of the chosen microphone. */
  deviceId: string;
}

const DEFAULTS: SttSettings = {
  engine: "local",
  endpoint: "",
  key: "",
  model: "",
  localModel: "Xenova/whisper-base",
  nativeModel: DEFAULT_STT_MODEL,
  language: "",
  deviceId: "",
};

const file = (): string => join(getDataDir(), "stt.json");

function encrypt(text: string): string {
  if (!text) return "";
  // No OS keyring (a bare Linux box): store as-is rather than lose the key.
  if (!safeStorage.isEncryptionAvailable()) return text;
  return safeStorage.encryptString(text).toString("base64");
}

function decrypt(text: string): string {
  if (!text) return "";
  if (!safeStorage.isEncryptionAvailable()) return text;
  try {
    return safeStorage.decryptString(Buffer.from(text, "base64"));
  } catch {
    // Written on another machine, or before encryption was available.
    return text;
  }
}

export function getSttSettings(): SttSettings {
  try {
    const p = file();
    if (!existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<SttSettings>;
    return {
      ...DEFAULTS,
      ...raw,
      key: decrypt(typeof raw.key === "string" ? raw.key : ""),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Patch-merge, so a caller can save one field without reading the rest. */
export function setSttSettings(patch: Partial<SttSettings>): SttSettings {
  const next = { ...getSttSettings(), ...patch };
  try {
    writeFileSync(
      file(),
      JSON.stringify({ ...next, key: encrypt(next.key) }, null, 2),
      "utf-8",
    );
  } catch {
    /* a settings write that fails must not take dictation down with it */
  }
  return next;
}

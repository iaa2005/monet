/**
 * Is Voice Mode usable yet?
 *
 * Voice Mode needs two engines to be ready at once — one to hear, one to
 * speak — and each can be unready for a different reason: a model that was
 * never downloaded, a cloud endpoint with no key, a voice that is chosen but
 * missing from disk. Discovering that by opening the conversation and
 * watching it fail is the worst version of this: the user is already talking.
 *
 * So the question is answered BEFORE the door opens, and it is answered here
 * rather than in the renderer, because "what does Voice Mode require" is a
 * policy that also governs the run itself. The UI only renders the answer.
 */

import { ipcMain } from "electron";
import { getSttSettings } from "../stt/settings.js";
import { listSttModels } from "../stt/gigaam.js";
import { sttNativeAvailable } from "../stt/gigaam.js";
import { ttsStatus, ttsNativeAvailable } from "../tts/engine.js";

export interface VoiceReadinessPart {
  ok: boolean;
  /** Why not, in the user's terms. Empty when ok. */
  reason: string;
}

export interface VoiceReadiness {
  ready: boolean;
  /** Hearing: whichever STT engine is configured. */
  stt: VoiceReadinessPart;
  /** Speaking: the Supertonic model and the chosen voice. */
  tts: VoiceReadinessPart;
}

async function sttReady(): Promise<VoiceReadinessPart> {
  const s = getSttSettings();
  if (s.engine === "cloud") {
    if (!s.endpoint.trim())
      return { ok: false, reason: "Cloud speech recognition has no endpoint set." };
    if (!s.key.trim())
      return { ok: false, reason: "Cloud speech recognition has no API key set." };
    return { ok: true, reason: "" };
  }
  if (s.engine === "ondevice") {
    if (!sttNativeAvailable())
      return {
        ok: false,
        reason: "On-device recognition is not available in this build.",
      };
    const models = await listSttModels();
    const chosen = models.find((m) => m.id === s.nativeModel);
    // No pick yet is the same situation as a missing download: either way
    // there is nothing to transcribe with.
    if (!chosen?.installed)
      return {
        ok: false,
        reason: models.some((m) => m.installed)
          ? "No on-device recognition model is selected."
          : "The speech recognition model is not downloaded yet.",
      };
    return { ok: true, reason: "" };
  }
  // "local": Whisper runs in the renderer and fetches its weights on first
  // use, so there is nothing to prepare here.
  return { ok: true, reason: "" };
}

async function ttsReady(): Promise<VoiceReadinessPart> {
  if (!ttsNativeAvailable())
    return { ok: false, reason: "On-device voice is not available in this build." };
  const st = await ttsStatus();
  if (!st.installed)
    return { ok: false, reason: "The voice model is not downloaded yet." };
  const chosen = getSttSettings().ttsVoice;
  const voice = st.voices.find((v) => v.id === chosen);
  if (!voice?.installed)
    return { ok: false, reason: "No voice is downloaded and selected yet." };
  return { ok: true, reason: "" };
}

/** The answer, without the IPC around it — so a probe can ask directly. */
export async function readiness(): Promise<VoiceReadiness> {
  const [stt, tts] = await Promise.all([sttReady(), ttsReady()]);
  return { ready: stt.ok && tts.ok, stt, tts };
}

export function registerVoiceIPC(): void {
  ipcMain.handle("voice:readiness", (): Promise<VoiceReadiness> => readiness());
}
